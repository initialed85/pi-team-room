// Backend dispatcher. HTTP/mDNS remains the default network backend; IRC is an
// explicit opt-in transport selected with PI_TEAM_ROOM_NETWORK=irc.
if (process.env.PI_TEAM_ROOM_NETWORK === "irc") {
  await import("./irc-service.mjs");
} else {
  await import("./http-network-service.mjs");
}
