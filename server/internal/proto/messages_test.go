package proto

import (
	"encoding/json"
	"reflect"
	"testing"
)

// Golden JSON per message type (testdata/msg-<t>.json), the field-name contract with the TS
// client (Task C1 parses each file with its own types).
func sampleMessages() map[string]any {
	return map[string]any{
		"hello": Hello{T: THello, World: "7f3c2a1e-0000-4000-8000-000000000001", Name: "Noah",
			Skin: "sky", Bid: "b-123", Proto: Proto, Gen: 3, Resume: true},
		"pos":  Pos{T: TPos, X: 1.25, Y: 70, Z: -3.5, Yaw: 1.571, Pitch: -0.25},
		"ping": Ping{T: TPing},
		"edit": Edit{T: TEdit, Cid: 17, Ops: []Op{{1, 2, 3, 13, 0x80, 0}, {4, 5, 6, 1000, 0, 0x1FFF5E0}}},
		"fx":   Fx{T: TFx, Kind: "mine", X: 10, Y: 64, Z: 12, Tier: 2, Dur: 1500, By: 3},
		"extras": Extras{T: TExtras,
			Data: json.RawMessage(`{"inventory":{"1":5},"tools":[],"hotbar":[1,2],"selected":0}`)},
		"leaving": Leaving{T: TLeaving, SecondsLeft: 120, By: 2},
		"welcome": Welcome{T: TWelcome, You: 2,
			World: WorldInfo{UUID: "7f3c2a1e-0000-4000-8000-000000000001", Name: "Castle",
				Seed: 123456789, Gen: 3, Height: 256, MustMine: true},
			Spawn:   Spawn{Mode: SpawnNear, X: 10.5, Y: 70, Z: 20.5, Yaw: 0.5, Pitch: 0, Target: 1},
			Extras:  json.RawMessage(`{}`),
			Players: []PlayerInfo{{ID: 1, Name: "Emma", Skin: "rose", X: 11, Y: 70, Z: 21, Yaw: 3.14, Pitch: 0.1, HasPos: true}},
			Seq:     4242, CatalogMax: CatalogMax},
		"edit-out": EditOut{T: TEdit, Seq: 4243, By: 2, Cid: 17,
			Ops: []Op{{1, 2, 3, 13, 0x8F, 0}, {4, 5, 6, 1000, 0, 0x1000000}}},
		"tick":  Tick{T: TTick, Poses: [][6]float64{{1, 11.25, 70, 21.5, 3.142, -0.1}}},
		"join":  Join{T: TJoin, ID: 3, Name: "Léa", Skin: "leaf"},
		"left":  Left{T: TLeft, ID: 3},
		"error": ErrorMsg{T: TError, Code: CloseNameTaken, Message: "name_taken"},
		"worlds-row": WorldListing{UUID: "7f3c2a1e-0000-4000-8000-000000000001", Name: "Castle",
			MustMine: false, CreatedAt: 1790000000000,
			Online: []OnlinePlayer{{Name: "Emma", Skin: "rose"}}},
	}
}

func TestGoldenMessages(t *testing.T) {
	for name, msg := range sampleMessages() {
		b, err := json.MarshalIndent(msg, "", "\t")
		if err != nil {
			t.Fatal(err)
		}
		golden(t, "msg-"+name+".json", append(b, '\n'))

		// Every committed file round-trips through the Go type unchanged.
		ptr := reflect.New(reflect.TypeOf(msg))
		if err := json.Unmarshal(readTestdata(t, "msg-"+name+".json"), ptr.Interface()); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !reflect.DeepEqual(normalizeRaw(ptr.Elem().Interface()), normalizeRaw(msg)) {
			t.Fatalf("%s: decode(golden) != sample", name)
		}
	}
}

// normalizeRaw re-marshals compactly so indented json.RawMessage fields compare equal.
func normalizeRaw(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// Field names are lowercase and exact: a Go field without a tag would marshal as "X", "Yaw", ….
func TestMessageFieldNames(t *testing.T) {
	want := map[string][]string{
		"hello":      {"t", "world", "name", "skin", "bid", "proto", "gen", "resume"},
		"pos":        {"t", "x", "y", "z", "yaw", "pitch"},
		"ping":       {"t"},
		"edit":       {"t", "cid", "ops"},
		"fx":         {"t", "kind", "x", "y", "z", "tier", "dur", "by"},
		"extras":     {"t", "data"},
		"leaving":    {"t", "secondsLeft", "by"},
		"welcome":    {"t", "you", "world", "spawn", "extras", "players", "seq", "catalogMax"},
		"edit-out":   {"t", "seq", "by", "cid", "ops"},
		"tick":       {"t", "poses"},
		"join":       {"t", "id", "name", "skin"},
		"left":       {"t", "id"},
		"error":      {"t", "code", "message"},
		"worlds-row": {"uuid", "name", "mustMine", "createdAt", "online"},
	}
	nested := map[string][]string{
		"world":  {"uuid", "name", "seed", "gen", "height", "mustMine"},
		"spawn":  {"mode", "x", "y", "z", "yaw", "pitch", "target"},
		"player": {"id", "name", "skin", "x", "y", "z", "yaw", "pitch", "hasPos"},
		"online": {"name", "skin"},
	}
	msgs := sampleMessages()
	for name, keys := range want {
		assertKeys(t, name, msgs[name], keys)
	}
	w := msgs["welcome"].(Welcome)
	assertKeys(t, "welcome.world", w.World, nested["world"])
	assertKeys(t, "welcome.spawn", w.Spawn, nested["spawn"])
	assertKeys(t, "welcome.players[0]", w.Players[0], nested["player"])
	assertKeys(t, "worlds-row.online[0]", msgs["worlds-row"].(WorldListing).Online[0], nested["online"])
}

func assertKeys(t *testing.T, name string, v any, keys []string) {
	t.Helper()
	b, _ := json.Marshal(v)
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if len(m) != len(keys) {
		t.Errorf("%s: got keys %v, want %v", name, keysOf(m), keys)
		return
	}
	for _, k := range keys {
		if _, ok := m[k]; !ok {
			t.Errorf("%s: missing key %q (got %v)", name, k, keysOf(m))
		}
	}
}

func keysOf(m map[string]json.RawMessage) []string {
	var ks []string
	for k := range m {
		ks = append(ks, k)
	}
	return ks
}

// Omitempty drops only absent optionals: by/tier/cid/target of 0 vanish, which is why player
// ids start at FirstPlayerID = 1.
func TestOmitEmpty(t *testing.T) {
	if FirstPlayerID < 1 {
		t.Fatal("player ids must start at 1 so by,omitempty never drops a real id")
	}
	b, _ := json.Marshal(Fx{T: TFx, Kind: "prime"})
	if string(b) != `{"t":"fx","kind":"prime","x":0,"y":0,"z":0}` {
		t.Fatalf("fx = %s", b)
	}
	b, _ = json.Marshal(EditOut{T: TEdit, Seq: 1, By: FirstPlayerID, Ops: []Op{}})
	if string(b) != `{"t":"edit","seq":1,"by":1,"ops":[]}` {
		t.Fatalf("edit = %s", b)
	}
}

// ops-roundtrip.json: fluid 0x80/0x8F and packed colours survive JSON both ways (the fluid bug
// in spec §4 G1 was a dropped field in transit).
func TestOpsRoundTrip(t *testing.T) {
	ops := []Op{
		{0, 0, 0, 0, 0, 0},
		{1, 64, 1, 13, 0x80, 0},
		{2, 64, 2, 13, 0x8F, 0},
		{3, 64, 3, 13, 0x83, 0},
		{4, 70, 4, 1000, 0, 0x1FFF5E0},
		{5, 70, 5, 1000, 0, 0x1000000},
		{511, 255, 511, CatalogMax, 0, 0x1FFFFFF},
	}
	msg := EditOut{T: TEdit, Seq: 9, By: 1, Cid: 5, Ops: ops}
	b, err := json.MarshalIndent(msg, "", "\t")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "ops-roundtrip.json", append(b, '\n'))
	var back EditOut
	if err := json.Unmarshal(readTestdata(t, "ops-roundtrip.json"), &back); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back, msg) {
		t.Fatalf("round-trip: %+v", back)
	}
	if err := ValidateOps(back.Ops, 256, CatalogMax); err != nil {
		t.Fatal(err)
	}
}

func TestCloseCodes(t *testing.T) {
	got := []int{CloseReplaced, CloseSlow, CloseResync, CloseProto, CloseGenUnsupported,
		CloseUnknownWorld, CloseBadToken, CloseBadName, CloseNameTaken}
	for i, c := range got {
		if c != 4001+i {
			t.Errorf("close code %d = %d, want %d", i, c, 4001+i)
		}
	}
	if Proto != 1 || MinProto != 1 || MaxProto != 1 {
		t.Fatalf("proto range = %d [%d, %d]", Proto, MinProto, MaxProto)
	}
}
