package proto

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// ValidateOps checks a whole batch (spec §5). Any invalid op rejects the batch: the caller closes
// with CloseResync, because the author's screen is already wrong (G1: silent drops left an
// invisible divergence).
func ValidateOps(ops []Op, height int, catalogMax int) error {
	if len(ops) > MaxOpsPerEdit {
		return fmt.Errorf("%d ops in one edit, max %d", len(ops), MaxOpsPerEdit)
	}
	for i, op := range ops {
		x, y, z, id, fluid, color := op[0], op[1], op[2], op[3], op[4], op[5]
		switch {
		case x < 0 || x >= WorldSize || z < 0 || z >= WorldSize:
			return fmt.Errorf("op %d: x,z (%d,%d) out of range", i, x, z)
		case y < 0 || int(y) >= height:
			return fmt.Errorf("op %d: y %d out of [0,%d)", i, y, height)
		case id < 0 || int(id) > catalogMax:
			return fmt.Errorf("op %d: id %d out of [0,%d]", i, id, catalogMax)
		case fluid < 0 || fluid > 0xFF:
			return fmt.Errorf("op %d: fluid %d is not a byte", i, fluid)
		case color != 0 && (color < 0x1000000 || color > 0x1FFFFFF):
			return fmt.Errorf("op %d: color %#x is not 0 or 0x1000000|rgb", i, color)
		}
	}
	return nil
}

var nameRule = regexp.MustCompile(`^[\p{L}\p{N} ]{1,16}$`)

var ErrBadName = errors.New("a name is 1-16 letters, numbers and spaces")

// NameKey returns the server-side name key (spec §5): trimmed, NFC-normalised, lowercased.
// Normalisation comes before the rule check, so a decomposed "Noé" (e + U+0301, a mark, not a
// letter) is accepted and gets the same key as the precomposed one (G16).
func NameKey(name string) (string, error) {
	n := norm.NFC.String(strings.TrimSpace(name))
	if !nameRule.MatchString(n) {
		return "", ErrBadName
	}
	return norm.NFC.String(strings.ToLower(n)), nil
}

// MaxSkinBytes bounds hello.skin. Skins are preset ids ("red", "blue"...); the bound only keeps a
// client with the token from storing megabytes in players.skin and every join/welcome/listing.
const MaxSkinBytes = 32

// ValidFxFace is true for exactly the six face strings a `fx mine` may carry. The relay strips
// anything else (world.go CmdFx), so no arbitrary string reaches other clients.
func ValidFxFace(s string) bool {
	switch s {
	case "px", "nx", "py", "ny", "pz", "nz":
		return true
	}
	return false
}

// SkinOf returns the skin to store and relay for hello.skin: "" (the client's default skin) when
// it is over MaxSkinBytes, not UTF-8, or holds a control character. Unknown ids pass through, so a
// newer client's skin still reaches newer clients.
func SkinOf(s string) string {
	if len(s) > MaxSkinBytes || !utf8.ValidString(s) {
		return ""
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return ""
		}
	}
	return s
}
