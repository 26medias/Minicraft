package hub

import (
	"math/rand/v2"

	"minicraft/server/internal/proto"
	"minicraft/server/internal/store"
)

// ChooseSpawn picks the spawn mode (spec §7.2); the client computes the actual spot.
//
//   - resume with a known position → return (a reconnect always goes back to where the kid was,
//     never next to a friend: RG kid-lens);
//   - others online, not resuming → near a random online player, whose pose is copied in;
//   - a known position → return;
//   - otherwise → first.
//
// row is the player's saved or live record, nil if the player has never been in this world.
// online excludes the joining player. Online players without a pose yet (they joined and have not
// sent a pos) cannot be near targets.
func ChooseSpawn(row *store.PlayerRow, resume bool, online []*Player, rnd *rand.Rand) proto.Spawn {
	hasPos := row != nil && row.HasPos
	if resume && hasPos {
		return returnTo(row)
	}
	if !resume {
		var targets []*Player
		for _, p := range online {
			// Bots are never spawn-near targets (spec §4): a bot has no physics and may be
			// mid-air or inside stone.
			if p.HasPos && !p.Bot {
				targets = append(targets, p)
			}
		}
		if len(targets) > 0 {
			t := targets[rnd.IntN(len(targets))]
			return proto.Spawn{Mode: proto.SpawnNear, Target: t.ID, X: t.X, Y: t.Y, Z: t.Z, Yaw: t.Yaw, Pitch: t.Pitch}
		}
	}
	if hasPos {
		return returnTo(row)
	}
	return proto.Spawn{Mode: proto.SpawnFirst}
}

func returnTo(r *store.PlayerRow) proto.Spawn {
	return proto.Spawn{Mode: proto.SpawnReturn, X: r.X, Y: r.Y, Z: r.Z, Yaw: r.Yaw, Pitch: r.Pitch}
}
