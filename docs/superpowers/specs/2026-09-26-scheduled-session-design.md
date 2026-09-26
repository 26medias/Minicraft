# Scheduled session — design

Status: approved direction (Julien, 2026-09-26). Replaces the "Every day" rules and the Today
buttons built earlier on this branch (never deployed).

## Why

Julien: "I tell my kid he can only play after 7am and for 45 min. I'd go to Single Player or
Multiplayer, press Schedule, select the map, what time it can start and for how long, click OK,
and the screen is now locked on this. Before the set time there is a countdown. If they refresh,
same thing." Rulings: **one session only** (not every day); the parent may **lock a world or let
the kid choose**; **no name/skin choice before the start time** (zero incentive to wake early).

## The model

A **plan** is one scheduled play session, stored in `minicraft:v1:plan`:

    { mode: 'solo' | 'mp', worldId: string | null, worldName: string | null,
      startAt: epoch ms, limitMin: 10..120 step 5, extraMin: 0.., createdAt: epoch ms }

`worldId: null` = the kid chooses among that mode's worlds.

A plan moves through three phases, derived from the plan, the play session and the clock
(`planPhase`):

| Phase | When | The kid sees |
|---|---|---|
| **wait** | now < startAt | the plaque "Not yet · play at 7:00 AM" + a coarse countdown; nothing else |
| **play** | started, time left | the plan's screen: the world (or his worlds), Play, the plaque "25 minutes left" |
| **done** | played ≥ limit + extra | "All done! · your world is saved"; nothing to play |

**The lock is sticky.** A plan stays until a parent ends it or replaces it, including after
**done**. There is no midnight reset: the next session needs the next plan. So "can't play before
7am" is: at night the parent schedules tomorrow 7:00; at 5 am there is nothing to play.

**No plan:** free play as before this branch's rules: home, both modes, the kid's own −/+
duration (10 min … No limit), the honour-system refresh rule.

## Time accounting

- The plan's play session is the ordinary `minicraft:v1:playtime` record. Under a plan,
  `resolveSession` uses the stored session only if it started at/after `plan.createdAt`
  (a session from before the plan never counts), carries its played time, recomputes the limit
  as `limitMin + extraMin` and freezes iff played ≥ limit. Otherwise a new session of that limit.
  The kid's duration is ignored.
- Play time counts only while the game runs and the page is visible (unchanged); a multiplayer
  server that is asleep costs nothing (the session starts at `startGame`, after `welcome`).
- Reloads keep the session under a plan (boot refresh rule: plan active ⇒ keep).
- Unreadable plan record ⇒ **broken** ⇒ locked (fail closed), with "Something's wrong · ask a
  parent" and the Parents button.

## Countdown (wait phase)

Coarse and dull, never seconds: "in 2 hours", "in 1 hour", "in 45 minutes", … "in 1 minute".
Recomputed every second so Play turns on at `startAt` without a reload; only the text granularity
is coarse. Text: headline "Not yet", sub "play at 7:00 AM · in 2 hours".

## Screens

**Home (no plan):** unchanged (Single Player, Multiplayer, Parents, Options).

**Under a plan the menu opens straight onto the plan's screen** (home and the other mode are
unreachable; Back is replaced by a small **Parents** button):

- *Solo:* Single Player with New World, Delete and the duration control hidden. Locked world:
  only that row; free choice: his solo worlds. Play enabled only in **play**.
- *Multiplayer:* in **wait** and **done**, a card with the plaque and Parents only (no name/skin).
  In **play**, the normal flow: name & skin (screen 1 when no name is remembered, "change"
  otherwise), then the worlds screen filtered like solo, New World hidden.

**Schedule button** (Single Player and Multiplayer, when no plan): a stone button under Play.
PIN-gated: with no PIN it first asks to set one (typed twice). The dialog:

- **World:** "Only <selected world>" (default when a world is selected) or "Let him choose".
- **Starts:** "Now" or "At [time]". A time already passed today means tomorrow; the dialog says
  "Today, 7:00 AM" / "Tomorrow, 7:00 AM" under the field.
- **Play for:** −/+ from 10 min to 2 h (default 45 min).
- **OK** reads the plan back: "Lock: Big Crafting · tomorrow 7:00 AM · 45 min". Cancel.

After OK the menu shows the locked screen immediately (the parent sees what he sees).

**Parents on the locked screen** (PIN): "Played 20 of 45 min" (or "Starts tomorrow 7:00 AM"),
**+15 min**, **Change** (the dialog, prefilled), **End schedule** (back to free play). Each
confirms in a sentence.

**Parents from home:** Parent PIN (typed twice; change; remove; forgot hint on the prompt) and the
multiplayer worlds. A hint: "To plan a play session, press Schedule in Single Player or
Multiplayer."

**Freeze under a plan:** title "ALL DONE!", line "GREAT BUILDING · YOUR WORLD IS SAVED", MENU.
Without a plan the kid-picked timer keeps TIME'S UP / ASK A PARENT.

## Migration

- `minicraft:v1:schedule` (deployed daily per-world schedule): becomes a solo plan on that world
  with the next occurrence of its start time and its minutes, then is removed only once the plan
  is written. An unreadable one ⇒ broken.
- `maxDurationMin` (deployed per-sitting maximum): no longer applies (documented; free play
  without a plan has no maximum).
- This branch's `minicraft:v1:rules` / `minicraft:v1:today` were never deployed: ignored.

## Out of scope

Recurring plans, several kids, other devices/browsers (the lock is per browser), clock changes.

## Review amendments (spec gate, 2026-09-26)

- **Plan identity (M4).** The plan carries an `id`; the play session record carries `planId`.
  Under a plan a session counts iff `session.planId === plan.id` (no clock comparison, no 12-hour
  staleness). **Change** keeps the id (played time kept, new limit applies); **End schedule**
  clears the session (free play starts clean); a **new plan** gets a new id. Free play ignores any
  session that carries a `planId`.
- **A plan ends with its start day (M1).** Phase **done** also when the local day of `startAt` is
  over, so unused minutes are not playable at 5 am the next day. Still one session; +15 / Change
  still work the same day.
- **Running games watch the plan (M2).** Every running game (free play with No limit included)
  checks the plan every second: if its identity (id, start, limit; not +15) differs from the one
  the game started under, or the plan's day ends, the game freezes (autojoin cleared) and MENU
  reloads onto the locked screen.
- **Every entry is checked (M3).** `planAllows({mode, worldId}, plan, session, now)`: phase
  **play**, same mode, and the locked world if any. Applied to `new`, `continue`, `mp` and the
  multiplayer autojoin boot. Under a plan, New World is not reachable.
- **Two tabs (S3).** Each tick first adopts the stored played time when it is higher for the same
  session, so two tabs cannot double the time.
- **Missing world (S2).** A locked world that is not listed (deleted, or the multiplayer server
  does not list it): plaque "Your world isn't here · ask a parent"; no time counts. Multiplayer
  matches on the world uuid.
- **Free-play unlock (S4).** Parents from home shows the free-play timer state and a
  **Reset play time** button when one is running or frozen.
- **PIN under a plan (S5).** Schedule requires a PIN (set one inline, typed twice). Remove PIN is
  refused while a plan exists ("End the schedule first").
- **Migration (S1).** Only when the plan key is absent; the old record is removed once the plan
  is written, and End removes both. Migrating after today's start time moves the session to
  tomorrow (accepted; one-time).
- "At [time]" equal to the current minute means tomorrow.
