package hub

import (
	"math/rand/v2"
	"testing"

	"minicraft/server/internal/proto"
	"minicraft/server/internal/store"
)

// G6: one case per ChooseSpawn branch (spec §7.2).
func TestChooseSpawnG6(t *testing.T) {
	rnd := rand.New(rand.NewPCG(1, 2))
	saved := &store.PlayerRow{NameKey: "noah", X: 10, Y: 70, Z: 20, Yaw: 1.5, Pitch: -0.25, HasPos: true}
	noPos := &store.PlayerRow{NameKey: "noah"}
	friend := &Player{ID: 7, Name: "Léa", X: 100, Y: 64, Z: 200, Yaw: 0.75, Pitch: 0.1, HasPos: true}
	other := &Player{ID: 9, Name: "Max", X: -1, Y: 80, Z: 300, Yaw: 2, Pitch: 0, HasPos: true}

	wantReturn := proto.Spawn{Mode: proto.SpawnReturn, X: 10, Y: 70, Z: 20, Yaw: 1.5, Pitch: -0.25}

	t.Run("resume with a saved pos returns", func(t *testing.T) {
		if got := ChooseSpawn(saved, true, nil, rnd); got != wantReturn {
			t.Fatalf("got %+v, want %+v", got, wantReturn)
		}
	})
	t.Run("resume with others online still returns, never near", func(t *testing.T) {
		if got := ChooseSpawn(saved, true, []*Player{friend, other}, rnd); got != wantReturn {
			t.Fatalf("got %+v, want %+v", got, wantReturn)
		}
	})
	t.Run("others online and no resume goes near a random target", func(t *testing.T) {
		seen := map[int]bool{}
		for i := 0; i < 200; i++ {
			got := ChooseSpawn(saved, false, []*Player{friend, other}, rnd)
			if got.Mode != proto.SpawnNear {
				t.Fatalf("mode %q, want near", got.Mode)
			}
			var tgt *Player
			switch got.Target {
			case friend.ID:
				tgt = friend
			case other.ID:
				tgt = other
			default:
				t.Fatalf("target %d is not an online player", got.Target)
			}
			want := proto.Spawn{Mode: proto.SpawnNear, Target: tgt.ID, X: tgt.X, Y: tgt.Y, Z: tgt.Z, Yaw: tgt.Yaw, Pitch: tgt.Pitch}
			if got != want {
				t.Fatalf("got %+v, want the target's pose copied in: %+v", got, want)
			}
			seen[got.Target] = true
		}
		if !seen[friend.ID] || !seen[other.ID] {
			t.Fatalf("target is not random: saw %v over 200 draws", seen)
		}
	})
	t.Run("never joined with others online goes near", func(t *testing.T) {
		if got := ChooseSpawn(nil, false, []*Player{friend}, rnd); got.Mode != proto.SpawnNear || got.Target != friend.ID {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("nobody online with a saved pos returns", func(t *testing.T) {
		if got := ChooseSpawn(saved, false, nil, rnd); got != wantReturn {
			t.Fatalf("got %+v, want %+v", got, wantReturn)
		}
	})
	t.Run("never joined and nobody online is first", func(t *testing.T) {
		if got := ChooseSpawn(nil, false, nil, rnd); got != (proto.Spawn{Mode: proto.SpawnFirst}) {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("a row without a pos is first", func(t *testing.T) {
		if got := ChooseSpawn(noPos, true, nil, rnd); got != (proto.Spawn{Mode: proto.SpawnFirst}) {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("online players without a pose yet are not near targets", func(t *testing.T) {
		fresh := &Player{ID: 3, Name: "New"}
		if got := ChooseSpawn(nil, false, []*Player{fresh}, rnd); got != (proto.Spawn{Mode: proto.SpawnFirst}) {
			t.Fatalf("got %+v, want first (the only online player has no pose)", got)
		}
	})

	// spec §4: bots are never spawn-near targets.
	bot := &Player{ID: 11, Name: "Robo", Bot: true, HasPos: true, X: 1, Y: 2, Z: 3, Yaw: 0.5, Pitch: 0}
	t.Run("only a bot online, never joined, falls back to first", func(t *testing.T) {
		if got := ChooseSpawn(nil, false, []*Player{bot}, rnd); got != (proto.Spawn{Mode: proto.SpawnFirst}) {
			t.Fatalf("got %+v, want first (bots filtered out leave no target)", got)
		}
	})
	t.Run("only a bot online, a saved pos falls back to return", func(t *testing.T) {
		if got := ChooseSpawn(saved, false, []*Player{bot}, rnd); got != wantReturn {
			t.Fatalf("got %+v, want return (bots filtered out leave no target)", got)
		}
	})
	t.Run("a bot and a kid online: the bot is never picked", func(t *testing.T) {
		for i := 0; i < 200; i++ {
			got := ChooseSpawn(nil, false, []*Player{bot, friend}, rnd)
			if got.Mode != proto.SpawnNear || got.Target != friend.ID {
				t.Fatalf("got %+v, want near the kid, never the bot", got)
			}
		}
	})
}
