// Package proto holds the multiplayer wire protocol (spec §5): message structs, close codes, op
// validation, name keys and the snapshot codec. The JSON field names are the contract with the
// TS client in src/net/protocol.ts; testdata/msg-*.json pins them.
package proto

import "encoding/json"

// Protocol version. The server accepts a hello whose proto is in [MinProto, MaxProto].
const (
	Proto    = 1
	MinProto = 1
	MaxProto = 1
)

// Limits (spec §5).
const (
	MaxOpsPerEdit = 2000
	WorldSize     = 512 // 0 ≤ x, z < WorldSize
	// FirstPlayerID: player ids start at 1, so `by,omitempty` never drops a real id.
	FirstPlayerID = 1
)

// Close and error codes (spec §5).
const (
	CloseReplaced       = 4001 // a newer connection from this browser took over
	CloseSlow           = 4002 // the send queue filled up
	CloseResync         = 4003 // the server rejected a batch
	CloseProto          = 4004 // proto version out of range
	CloseGenUnsupported = 4005 // generator version not supported
	CloseUnknownWorld   = 4006 // the world doesn't exist
	CloseBadToken       = 4007 // wrong token
	CloseBadName        = 4008 // name failed the name rule
	CloseNameTaken      = 4009 // the name is online from another browser
)

// Message types (the "t" field).
const (
	THello   = "hello"
	TPos     = "pos"
	TPing    = "ping"
	TEdit    = "edit"
	TFx      = "fx"
	TExtras  = "extras"
	TLeaving = "leaving"
	TWelcome = "welcome"
	TTick    = "tick"
	TJoin    = "join"
	TLeft    = "left"
	TError   = "error"
)

// Spawn modes (spec §7.2).
const (
	SpawnFirst  = "first"
	SpawnReturn = "return"
	SpawnNear   = "near"
)

// Op is one cell write: x, y, z, id, fluid (raw fluidMeta: 0 = none/source, 0x80|d = flow at
// distance d), color (0 = none, else 0x1000000|rgb). It marshals as a 6-number JSON array.
type Op [6]int32

// Envelope reads only the message type, to dispatch on.
type Envelope struct {
	T string `json:"t"`
}

// ── client → server ──

type Hello struct {
	T      string `json:"t"`
	World  string `json:"world"`
	Name   string `json:"name"`
	Skin   string `json:"skin"`
	Bid    string `json:"bid"`
	Proto  int    `json:"proto"`
	Gen    int    `json:"gen"`
	Resume bool   `json:"resume"`
}

type Pos struct {
	T     string  `json:"t"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Z     float64 `json:"z"`
	Yaw   float64 `json:"yaw"`
	Pitch float64 `json:"pitch"`
}

// Ping is sent both ways (spec §3.1).
type Ping struct {
	T string `json:"t"`
}

// Edit is a client batch; the server echoes it to everyone as EditOut (same "t").
type Edit struct {
	T   string `json:"t"`
	Cid int64  `json:"cid"`
	Ops []Op   `json:"ops"`
}

// Fx is cosmetic (kind: prime|boom|firework). By is set by the server on relay.
type Fx struct {
	T    string `json:"t"`
	Kind string `json:"kind"`
	X    int    `json:"x"`
	Y    int    `json:"y"`
	Z    int    `json:"z"`
	Tier int    `json:"tier,omitempty"`
	By   int    `json:"by,omitempty"`
}

// Extras carries {inventory, tools, hotbar, selected}, opaque to the server.
type Extras struct {
	T    string          `json:"t"`
	Data json.RawMessage `json:"data"`
}

// Leaving announces the sender's play-time countdown (spec §7.4). By is set on relay.
type Leaving struct {
	T           string `json:"t"`
	SecondsLeft int    `json:"secondsLeft"`
	By          int    `json:"by,omitempty"`
}

// ── server → client ──

type Welcome struct {
	T          string          `json:"t"`
	You        int             `json:"you"`
	World      WorldInfo       `json:"world"`
	Spawn      Spawn           `json:"spawn"`
	Extras     json.RawMessage `json:"extras"`
	Players    []PlayerInfo    `json:"players"`
	Seq        uint32          `json:"seq"`
	CatalogMax int             `json:"catalogMax"`
}

type WorldInfo struct {
	UUID     string `json:"uuid"`
	Name     string `json:"name"`
	Seed     int64  `json:"seed"`
	Gen      int    `json:"gen"`
	Height   int    `json:"height"`
	MustMine bool   `json:"mustMine"`
}

// Spawn: Mode is first|return|near; Target is the player id for near.
type Spawn struct {
	Mode   string  `json:"mode"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Z      float64 `json:"z"`
	Yaw    float64 `json:"yaw"`
	Pitch  float64 `json:"pitch"`
	Target int     `json:"target,omitempty"`
}

type PlayerInfo struct {
	ID    int     `json:"id"`
	Name  string  `json:"name"`
	Skin  string  `json:"skin"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Z     float64 `json:"z"`
	Yaw   float64 `json:"yaw"`
	Pitch float64 `json:"pitch"`
}

// EditOut is the server-ordered edit sent to everyone, author included.
type EditOut struct {
	T   string `json:"t"`
	Seq uint32 `json:"seq"`
	By  int    `json:"by"`
	Cid int64  `json:"cid,omitempty"`
	Ops []Op   `json:"ops"`
}

// Tick: poses are [id, x, y, z, yaw, pitch]; x/y/z rounded to 0.01, yaw/pitch to 0.001.
type Tick struct {
	T     string       `json:"t"`
	Poses [][6]float64 `json:"poses"`
}

type Join struct {
	T    string `json:"t"`
	ID   int    `json:"id"`
	Name string `json:"name"`
	Skin string `json:"skin"`
}

type Left struct {
	T  string `json:"t"`
	ID int    `json:"id"`
}

type ErrorMsg struct {
	T       string `json:"t"`
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// ── HTTP ──

// WorldListing is one row of GET /worlds.
type WorldListing struct {
	UUID      string         `json:"uuid"`
	Name      string         `json:"name"`
	MustMine  bool           `json:"mustMine"`
	CreatedAt int64          `json:"createdAt"`
	Online    []OnlinePlayer `json:"online"`
}

type OnlinePlayer struct {
	Name string `json:"name"`
	Skin string `json:"skin"`
}
