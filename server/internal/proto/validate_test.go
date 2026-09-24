package proto

import (
	"strings"
	"testing"
)

const testHeight = 256

func TestValidateOpsRejectsOutOfRange(t *testing.T) {
	good := Op{10, 64, 10, 1, 0, 0}
	bad := map[string]Op{
		"x = -1":            {-1, 64, 10, 1, 0, 0},
		"x = 512":           {512, 64, 10, 1, 0, 0},
		"z = -1":            {10, 64, -1, 1, 0, 0},
		"z = 512":           {10, 64, 512, 1, 0, 0},
		"y = -1":            {10, -1, 10, 1, 0, 0},
		"y = height":        {10, testHeight, 10, 1, 0, 0},
		"id = -1":           {10, 64, 10, -1, 0, 0},
		"id = CatalogMax+1": {10, 64, 10, CatalogMax + 1, 0, 0},
		"fluid = -1":        {10, 64, 10, 13, -1, 0},
		"fluid = 256":       {10, 64, 10, 13, 256, 0},
		"color no marker":   {10, 64, 10, 1000, 0, 0xFFF5E0},
		"color too big":     {10, 64, 10, 1000, 0, 0x2000000},
		"color negative":    {10, 64, 10, 1000, 0, -1},
	}
	for name, op := range bad {
		// The bad op sits in the middle: any invalid op rejects the whole batch.
		if err := ValidateOps([]Op{good, op, good}, testHeight, CatalogMax); err == nil {
			t.Errorf("%s: batch accepted", name)
		}
	}
}

func TestValidateOpsAcceptsValidBatch(t *testing.T) {
	ops := []Op{
		{0, 0, 0, 0, 0, 0},
		{511, testHeight - 1, 511, CatalogMax, 0, 0},
		{10, 64, 10, 13, 0x80, 0},
		{10, 64, 10, 13, 0x8F, 0}, // the same cell twice is allowed, applied in order
		{11, 64, 10, 1000, 0, 0x1FFF5E0},
		{12, 64, 10, 1000, 0, 0x1000000},
	}
	if err := ValidateOps(ops, testHeight, CatalogMax); err != nil {
		t.Fatal(err)
	}
	// Height is per world, not a constant.
	if err := ValidateOps([]Op{{0, 300, 0, 1, 0, 0}}, 384, CatalogMax); err != nil {
		t.Fatal(err)
	}
	// catalogMax is a parameter, not the constant.
	if err := ValidateOps([]Op{{0, 1, 0, 50, 0, 0}}, testHeight, 49); err == nil {
		t.Fatal("id above the given catalogMax accepted")
	}
}

func TestValidateOpsBatchSize(t *testing.T) {
	ops := make([]Op, MaxOpsPerEdit)
	for i := range ops {
		ops[i] = Op{int32(i % 512), 1, int32(i / 512), 1, 0, 0}
	}
	if err := ValidateOps(ops, testHeight, CatalogMax); err != nil {
		t.Fatalf("%d ops rejected: %v", MaxOpsPerEdit, err)
	}
	if err := ValidateOps(append(ops, Op{0, 1, 0, 1, 0, 0}), testHeight, CatalogMax); err == nil {
		t.Fatalf("%d ops accepted", MaxOpsPerEdit+1)
	}
}

// G16: names.
func TestG16NameKey(t *testing.T) {
	nfc := "Noé"   // Noé, precomposed
	upper := "NOÉ" // NOÉ
	nfd := "Noé"  // Noé, decomposed
	a, errA := NameKey(nfc)
	b, errB := NameKey(upper)
	c, errC := NameKey(nfd)
	if errA != nil || errB != nil || errC != nil {
		t.Fatalf("errors: %v %v %v", errA, errB, errC)
	}
	if a != b || b != c {
		t.Fatalf("keys differ: %q %q %q", a, b, c)
	}
	if a != "noé" {
		t.Fatalf("key = %q, want %q", a, "noé")
	}
	for _, bad := range []string{"", "   ", "a<b", "Noah!", strings.Repeat("a", 17), "tab\there"} {
		if k, err := NameKey(bad); err == nil {
			t.Errorf("NameKey(%q) = %q, want error", bad, k)
		}
	}
	for _, ok := range []string{"Noah", "  Noah  ", "Noah 2", strings.Repeat("a", 16), "Zoë", "李雷"} {
		if _, err := NameKey(ok); err != nil {
			t.Errorf("NameKey(%q): %v", ok, err)
		}
	}
	if k, _ := NameKey("  Noah  "); k != "noah" {
		t.Errorf("trim: key = %q", k)
	}
}

func TestSkinOf(t *testing.T) {
	cases := map[string]string{
		"red":                               "red",
		"skin-léa":                          "skin-léa",
		strings.Repeat("x", MaxSkinBytes):   strings.Repeat("x", MaxSkinBytes),
		strings.Repeat("x", MaxSkinBytes+1): "",
		"bad\xffutf8":                       "",
		"tab\there":                         "",
	}
	for in, want := range cases {
		if got := SkinOf(in); got != want {
			t.Errorf("SkinOf(%q) = %q, want %q", in, got, want)
		}
	}
}
