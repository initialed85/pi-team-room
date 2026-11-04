package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

func main() {
	home := os.Getenv("HOME")
	if home == "" {
		home = "."
	}
	var (
		addr      = flag.String("addr", "127.0.0.1:8787", "listen address")
		sessions  = flag.String("sessions", filepath.Join(home, ".pi/agent/sessions"), "Pi sessions directory")
		statePath = flag.String("state", filepath.Join(home, ".pi/team-room/state.json"), "team-room state.json")
		interval  = flag.Duration("interval", 1200*time.Millisecond, "poll interval")
		show      = flag.Bool("open-browser", false, "print a ready line only, no browser launch")
	)
	flag.Parse()

	log.SetFlags(log.Ltime)
	if _, err := os.Stat(*sessions); err != nil {
		log.Fatalf("sessions directory %s: %v", *sessions, err)
	}
	srv := newServer(*sessions, *statePath, *interval)
	if !srv.bootstrap() {
		log.Fatalf("initial index failed for %s", *sessions)
	}
	go srv.poll()

	mux := srv.handler()
	httpServer := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	base := srv.snapshotHealth()
	log.Printf("team-room viewer on http://%s/  (%d sessions, %d direct messages, %d wakes, mode=chat+session)",
		*addr, base.Sessions, base.Direct, base.Wakes)
	if *show {
		log.Printf("open http://%s/ in your browser", *addr)
	}
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func (s *server) bootstrap() bool {
	s.refreshOnce()
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.base != nil
}

func (s *server) snapshotHealth() Health {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.base == nil {
		return Health{}
	}
	return s.base.Health
}
