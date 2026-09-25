# Letting players talk: options research (2026-09-24)

Goal: let the players in a multiplayer world talk to each other. This is research only. Nothing
has been built. Prices and browser facts were checked on 2026-09-24 against the linked pages;
the items marked **unverified** were not.

**Scope note.** `CLAUDE.md` lists "chat" as a hard non-goal. That line was written against
*public* chat: strangers, accounts, platforms. Multiplayer here is private to two families, so
talking between the two kids is a different question. Julien asked for this research, but the
non-goal line should be reworded if any of this is built.

## The constraints that shape the answer

- **The server is only reachable through a Cloudflare Tunnel.** The tunnel carries HTTP and
  WebSocket traffic. It does not carry public UDP: UDP only works for private networks where the
  other side runs a client ([cloudflared #964](https://github.com/cloudflare/cloudflared/issues/964)).
  So live voice audio cannot go through `mc.leap-forward.ca`. Only the small setup messages can.
- **There is already a relay that forwards JSON messages** (`mcserver`, like `fx` and
  `leaving`). A new message type is cheap. The read limit is 4 MiB.
- **The player is 7.** Reading and typing are weak, and holding a key while playing is hard.
- **Two players, sometimes 3 or 4.** Anything designed for large group calls is overkill.

## Option families

| # | Option | Effort over the existing relay | Fit for a 7-year-old | Verdict |
|---|---|---|---|---|
| A | Emote wheel (wave, clap, "follow me", "over there!", ❤️ 😂 👍), shown as a big emoji bubble over the avatar | Very low: one `emote` message plus a sprite | Excellent: no reading | **Build first** |
| B | "Come here" marker dropped on the block you look at, fading after ~10 s, with an arrow at the screen edge if it's off screen | Low: one `ping` message plus a marker | Excellent | **Build first** |
| C | Preset quick-chat phrases with icons, read aloud with `speechSynthesis` | Low; phrases are a `*.data.ts` table | Good, if every phrase has an icon and is spoken | Nice second step |
| D | Free text chat | Low | Poor: can't type well | Skip |
| E | Speech-to-text into chat | Medium | Fair at best | Skip |
| F | Recorded voice clips (hold to record, release to send, max 10 s) | Medium: MediaRecorder, then a binary frame through the relay | Very good: kids know voice notes from phones | Middle ground |
| G | Live voice: WebRTC peer to peer, set up over the existing WebSocket, with a hosted TURN fallback | Medium: ~200 lines of TS plus the relayed setup messages | Very good: they actually talk | **The real "talk" option** |
| H | Hosted voice platforms (LiveKit, Daily, Agora, Twilio Video, Cloudflare SFU) | Medium to high; SDK plus token minting | Same as G | Overkill for 2 players |

## Live voice (G): what "not reinventing the wheel" means here

The wheel is the browser's own WebRTC. For 2–4 players, each browser opens one audio connection
to each of the others (a "mesh"). `mcserver` only passes the setup messages between them. No
audio goes through the tunnel or the VM.

### Libraries and services compared

| Option | What you run | Cost at 2–4 kids | Verdict |
|---|---|---|---|
| **Native `RTCPeerConnection`**, offers/answers relayed as new JSON messages | ~200 lines of TS; `mcserver` forwards `voice-*` messages to the named player | $0 | **Recommended** |
| simple-peer | npm lib | $0 | Avoid: last commit 2022-02-17 ([npm](https://registry.npmjs.org/simple-peer)) |
| PeerJS | npm lib plus its own signalling server | $0 | Unnecessary: duplicates `mcserver` ([releases](https://github.com/peers/peerjs/releases)) |
| **Cloudflare Realtime TURN** (relay for when a direct connection fails) | Nothing hosted; `mcserver` mints short-lived credentials | First 1,000 GB/month free, then $0.05/GB ([pricing](https://developers.cloudflare.com/realtime/pricing/)) | **Recommended fallback** |
| coturn on the GCP VM | coturn, plus open 3478/udp+tcp, 5349/tcp and a UDP range | VM egress; GCP's free tier is 1 GB/month ([GCP](https://docs.cloud.google.com/free/docs/free-cloud-features)) | Workable, but adds a new internet-facing daemon beside the tunnel |
| Metered Open Relay | Nothing | Free 20 GB/month ([openrelay](https://www.metered.ca/tools/openrelay/)); paid from $99/month | Backup; **unverified** that the free tier is still running |
| Twilio NTS | Nothing | TURN $0.40–0.80/GB ([pricing](https://www.twilio.com/en-us/stun-turn/pricing)) | Costs more than Cloudflare for no gain |
| STUN: `stun.cloudflare.com`, `stun.l.google.com:19302` | Nothing | Free | Use both. Google publishes no terms for its STUN servers (**unverified**) |
| LiveKit Cloud | Hosted SFU plus `livekit-client` (~143 KB gzip) | Free: 5,000 participant-min, 50 GB/month ([pricing](https://livekit.com/pricing)) | Overkill |
| LiveKit self-hosted | Go server, 7881/tcp, 50000–60000/udp, TURN ([docs](https://docs.livekit.io/home/self-hosting/deployment/)) | VM egress | Overkill |
| Cloudflare Realtime SFU | Backend calls to the SFU API ([docs](https://developers.cloudflare.com/realtime/sfu/)) | Same 1,000 GB free | Overkill below ~5 peers |
| Daily / Agora | Hosted, proprietary SDK | 10,000 min/month free ([Daily](https://www.daily.co/pricing/), [Agora](https://www.agora.io/en/pricing/)) | Overkill; a third-party account |
| Twilio Video | Hosted | — | Still exists (its end-of-life was reversed, [changelog](https://www.twilio.com/en-us/changelog/-twilio-video-will-remain-a-standalone-product)); overkill |
| Jitsi / mediasoup / Janus / Pion SFU | Self-hosted media server | VM egress | Built for large group calls; pointless here |

### Why TURN from day one

A direct connection works on most home networks, but commonly cited figures say 15–50% of WebRTC
calls need a relay, depending on the users' networks
([webrtcHacks](https://webrtchacks.com/usage-stats/),
[fippo](https://medium.com/@fippo/so-i-read-that-20-of-webrtc-calls-fail-67b185e49765)). Without
one, the kids would get silence with no clear reason. Cloudflare's TURN also serves TLS on
443/tcp, which gets through restrictive networks
([CF TURN](https://developers.cloudflare.com/realtime/turn/)). The TURN key must stay on the
server; clients get short-lived credentials
([docs](https://developers.cloudflare.com/realtime/turn/generate-credentials/)).

**Cost is negligible.** Opus speech runs at 10–24 kbps
([Xiph](https://wiki.xiph.org/Opus_Recommended_Settings)). Our own estimate, with WebRTC
overhead: ~50 kbps per direction, ~22 MB per hour per direction. Two players for an hour, fully
relayed, is ~45 MB, a rounding error against the 1,000 GB free.

### Browser realities

- **HTTPS is required** for the microphone, which both the site and `localhost:5173` satisfy
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)). Ask for
  the mic from a big "🎤 Talk" button, never automatically.
- **Echo.** Kids on laptop speakers will cause echo. Request
  `echoCancellation`, `noiseSuppression` and `autoGainControl`, which are supported in every major
  browser ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/echoCancellation)).
- **Autoplay.** Starting voice from a click unlocks audio in Chrome and Safari
  ([Chrome](https://developer.chrome.com/blog/autoplay),
  [webrtcHacks](https://webrtchacks.com/autoplay-restrictions-and-webrtc/)).
- **iPad / Safari.** `<audio>.volume` can't be set from code on iOS, so volume needs a Web Audio
  `GainNode`
  ([Apple](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/Device-SpecificConsiderations/Device-SpecificConsiderations.html)).
  Turning on the mic can also move output from headphones to the speaker.
- **Spatial audio risk.** A 2020 write-up found Chromium did not echo-cancel audio played through
  Web Audio ([Focused](https://focused.io/lab/echo-cancellation-with-web-audio-api-and-chromium)),
  and routing remote WebRTC audio through Web Audio can be silent in Chrome unless the stream is
  also attached to a muted `<audio>` element. Chrome later changed its echo cancellation
  ([chromium issue](https://issues.chromium.org/issues/40871060)). **Unverified** how Chrome
  behaves in 2026: test on the actual laptops before promising proximity voice.

### Reference design: Simple Voice Chat

The Minecraft mod [Simple Voice Chat](https://modrinth.com/plugin/simple-voice-chat) is the
closest reference. It has proximity and 3D audio, push-to-talk or voice activation, per-player
volume, a mute icon, and speaking indicators over heads. It carries audio on its own UDP port
(24454), which is exactly the extra open port we'd rather avoid.

For a 7-year-old, the minimal version is:

- **Open mic by default plus one big mute button.** Push-to-talk is hard for a young child.
- **A speaking bubble over the avatar**, driven by an `AnalyserNode` level threshold. No library
  is needed.
- **One global channel, not proximity.** Proximity voice is a possible later step, but two
  friends who wander apart and "can't hear each other" will just be confused, and it carries the
  echo risk above.

## Non-voice options in more detail

- **Emotes (A) and markers (B).** Minecraft Bedrock's default emote wheel is Wave / Clap /
  Follow Me / Over There ([minecraft.net](https://www.minecraft.net/en-us/article/new-emote-features-bedrock-edition)).
  Splatoon gets by with two signals, "This way!" and "Booyah!"
  ([Inkipedia](https://splatoonwiki.org/wiki/Signal)). Apex Legends' ping system was designed by
  banning voice in playtests
  ([GameRevolution](https://www.gamerevolution.com/news/493241-apex-legends-ping-system)).
- **Quick chat (C).** Toontown's SpeedChat, layered menus of pre-written phrases, is the classic
  child-safe design ([wiki](https://toontown.fandom.com/wiki/SpeedChat)). Among Us forces quick
  chat on for under-13s ([wiki](https://among-us.fandom.com/wiki/Quick_Chat)).
  `speechSynthesis` works in all major browsers, but voices load late in Chrome and sound robotic
  in Firefox on Linux ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis)).
- **Speech-to-text (E).** Chrome sends the audio to Google by default
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)). An opt-in
  on-device mode arrived in Chrome 139 ([Chrome](https://developer.chrome.com/blog/new-in-chrome-139)).
  Firefox doesn't support it, and recognition of young children's voices is still poor
  ([JASA 2025](https://pubs.aip.org/asa/jel/article/5/3/035201/3338215/Voice-assistant-technology-continues-to)).
- **Voice clips (F).** A 10 s Opus clip is ~30–40 KB (our estimate), far under the relay's
  4 MiB limit, and needs no WebRTC, STUN or TURN. Chrome and Firefox record WebM/Opus. Safari
  18.4+ can too, but defaults to MP4/AAC, so playback must accept both
  ([WebKit](https://webkit.org/blog/11353/mediarecorder-api/)). We found no well-known game that
  sends recorded clips in-game (**unverified**); the pattern comes from walkie-talkie apps.
- **Libraries.** For A–F there is nothing worth pulling in. Hosted chat widgets (Stream,
  Sendbird, CometChat) bring accounts and back ends. Each option is one message type on the
  existing socket.

## Safety on a private two-family server

- There are no strangers, so the risks that make Roblox turn chat off for under-9s
  ([Roblox](https://about.roblox.com/newsroom/2025/11/roblox-requires-age-checks-limits-minor-and-adult-chat))
  mostly don't apply.
- Presets, emotes and markers need no filter because nothing can be typed.
- Rate-limit new message types on the server (e.g. 1 per second, burst 5). The realistic abuse
  case is a flood of 💩 bubbles, not danger.
- Live voice passes peer to peer and is never stored. Don't store clips either.
- COPPA covers commercial operators, and the FTC says it doesn't apply to non-commercial entities
  ([FTC FAQ](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions)).
  A private, unpaid family server is almost certainly outside it. PIPEDA also covers commercial
  activity. **Not legal advice; unverified against the regulation text.**

## Recommendation

1. **If "talk" means real voice:** native WebRTC audio between peers, with setup messages
   relayed by `mcserver`, STUN from Cloudflare and Google, and **Cloudflare Realtime TURN** as the
   fallback (free at this usage, no new ports on the VM). Use open mic, a big mute button, a
   speaking bubble and one global channel. No SDK and no media server.
2. **Either way, emotes plus a "come here" marker** are the cheapest high-value piece and work
   when a mic isn't available or allowed.
3. **Voice clips** are the fallback if live voice turns out to be unreliable on the kids'
   machines. They reuse the relay and need no connectivity setup.
4. **Skip** free text chat, speech-to-text, hosted voice platforms and self-hosted media
   servers.

### Before building live voice

- Try echo on the actual kids' laptops, on speakers, not headphones.
- Test locally only: two headless Chromium instances with `--use-fake-device-for-media-stream`
  against a local `mcserver`, never `mc.leap-forward.ca`.
- Decide where the Cloudflare TURN key lives (a `mcserver` flag or env var) and how `mcserver`
  hands out short-lived credentials on `welcome`.
