package proto

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// wireRoots is one root struct per wire message, keyed by the golden file name
// (server/internal/proto/testdata/msg-<key>.json; "edit-out" is the server→client Edit, keyed
// separately from the client→server "edit"). walk() reaches every nested struct from these roots
// and records it under "<parent>.<jsonName>" (e.g. "welcome.world", "worlds-row.online").
func wireRoots() map[string]any {
	return map[string]any{
		"hello":      Hello{},
		"pos":        Pos{},
		"ping":       Ping{},
		"edit":       Edit{},
		"edit-out":   EditOut{},
		"fx":         Fx{},
		"extras":     Extras{},
		"leaving":    Leaving{},
		"welcome":    Welcome{},
		"tick":       Tick{},
		"join":       Join{},
		"left":       Left{},
		"error":      ErrorMsg{},
		"worlds-row": WorldListing{},
	}
}

// envelopeExempt lists json-tagged structs in proto.go that are not wire messages, so
// TestWireStructsReachable does not require them to be reached from a wireRoots() entry.
//   - Envelope: reads only "t" to dispatch on the concrete message type; it is never a message
//     on its own wire, so it has no root of its own.
var envelopeExempt = map[string]bool{
	"Envelope": true,
}

// fieldsJSONPath is the checked-in golden file TestWireFields compares against and rewrites
// with -update.
const fieldsJSONPath = "testdata/fields.json"

// jsonName returns the json tag's field name (before the first comma) and whether it carries
// omitempty. skip is true for a "-" tag, which the encoder always drops.
func jsonName(f reflect.StructField) (name string, omitempty bool, skip bool) {
	tag := f.Tag.Get("json")
	if tag == "-" {
		return "", false, true
	}
	parts := strings.Split(tag, ",")
	name = parts[0]
	if name == "" {
		name = f.Name
	}
	for _, p := range parts[1:] {
		if p == "omitempty" {
			omitempty = true
		}
	}
	return name, omitempty, false
}

// walk records path's field names (a trailing "?" for omitempty) into out, and recurses into
// every nested struct reached through a pointer, slice or array field, under "<path>.<jsonName>".
// It also marks every struct type it visits (by Go type name) in reached, for the go/parser
// reachability check in TestWireStructsReachable.
func walk(t reflect.Type, path string, out map[string][]string, reached map[string]bool) {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return
	}
	reached[t.Name()] = true

	var names []string
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if f.PkgPath != "" { // unexported
			continue
		}
		name, omitempty, skip := jsonName(f)
		if skip {
			continue
		}
		if omitempty {
			names = append(names, name+"?")
		} else {
			names = append(names, name)
		}

		ft := f.Type
		for ft.Kind() == reflect.Pointer || ft.Kind() == reflect.Slice || ft.Kind() == reflect.Array {
			ft = ft.Elem()
		}
		if ft.Kind() == reflect.Struct {
			walk(ft, path+"."+name, out, reached)
		}
	}
	sort.Strings(names)
	out[path] = names
}

// TestWireFields is the reflection field list (spec §7, gate-2 amendment): it walks every wire
// struct's json tags — never a marshalled sample, so omitempty can't hide a field — and compares
// the sorted result with testdata/fields.json. Run with -update to rewrite it.
func TestWireFields(t *testing.T) {
	out := map[string][]string{}
	reached := map[string]bool{}
	for key, v := range wireRoots() {
		walk(reflect.TypeOf(v), key, out, reached)
	}

	got, err := json.MarshalIndent(out, "", "\t")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')

	if *update {
		if err := os.WriteFile(fieldsJSONPath, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}

	want, err := os.ReadFile(fieldsJSONPath)
	if err != nil {
		t.Fatalf("missing %s (run: go test ./internal/proto/... -run TestWireFields -update): %v", fieldsJSONPath, err)
	}
	var wantMap map[string][]string
	if err := json.Unmarshal(want, &wantMap); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(out, wantMap) {
		t.Fatalf("%s is stale (run: go test ./internal/proto/... -run TestWireFields -update)\ngot:\n%s\nwant:\n%s",
			fieldsJSONPath, got, want)
	}
}

// TestWireStructsReachable fails if any json-tagged struct declared in proto.go isn't reached
// from a wireRoots() entry (the one exemption is envelopeExempt). This catches a new wire struct
// that forgot to add a root, which TestWireFields alone wouldn't notice.
func TestWireStructsReachable(t *testing.T) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "proto.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}

	var declared []string
	for _, decl := range f.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.TYPE {
			continue
		}
		for _, spec := range gen.Specs {
			ts, ok := spec.(*ast.TypeSpec)
			if !ok {
				continue
			}
			st, ok := ts.Type.(*ast.StructType)
			if !ok {
				continue
			}
			if hasJSONTag(st) {
				declared = append(declared, ts.Name.Name)
			}
		}
	}

	reached := map[string]bool{}
	out := map[string][]string{}
	for key, v := range wireRoots() {
		walk(reflect.TypeOf(v), key, out, reached)
	}

	for _, name := range declared {
		if envelopeExempt[name] {
			continue
		}
		if !reached[name] {
			t.Errorf("proto.go: struct %s has json tags but is not reachable from any wireRoots() entry; add a root (or exempt it in envelopeExempt with a reason)", name)
		}
	}
}

func hasJSONTag(st *ast.StructType) bool {
	if st.Fields == nil {
		return false
	}
	for _, field := range st.Fields.List {
		if field.Tag == nil {
			continue
		}
		tagVal, err := strconv.Unquote(field.Tag.Value)
		if err != nil {
			continue
		}
		if reflect.StructTag(tagVal).Get("json") != "" {
			return true
		}
	}
	return false
}
