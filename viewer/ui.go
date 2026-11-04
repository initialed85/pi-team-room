package main

import "embed"

//go:embed ui/index.html
var indexHTML []byte

//go:embed ui/*
var uiAssets embed.FS

var _ = uiAssets
