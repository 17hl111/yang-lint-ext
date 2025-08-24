#!/usr/bin/env python3
"""
watcher.py — cross-platform .yang watcher with debounce that runs a command.

Usage:
  python3 /usr/local/bin/watcher.py --watchdir /workdir --pattern "*.yang" \
    --cmd "bash /usr/local/bin/watch-yang.sh --run-once" --debounce 1 --logfile /workdir/watch-yang.log [--use-polling]

Notes:
- Uses native observers (inotify/FSEvents/Win32) by default; use --use-polling to force polling
  (recommended for Docker Desktop mounts on Windows). When --use-polling is set, polling uses
  a 1 second timeout (poll interval).
"""
import argparse
import time
import threading
import subprocess
import sys
from pathlib import Path
from watchdog.events import PatternMatchingEventHandler
from watchdog.observers import Observer
from watchdog.observers.polling import PollingObserver

def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")

class DebouncedHandler(PatternMatchingEventHandler):
    def __init__(self, command, debounce, logfile, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.command = command
        self.debounce = float(debounce)
        self.logfile = Path(logfile) if logfile else None
        self._timer = None
        self._lock = threading.Lock()

    def _log(self, msg):
        text = f"{now_iso()}  {msg}"
        if self.logfile:
            try:
                with self.logfile.open("a") as f:
                    f.write(text + "\n")
            except Exception:
                pass
        else:
            print(text)

    def _schedule_run(self):
        with self._lock:
            if self._timer:
                self._timer.cancel()
            self._timer = threading.Timer(self.debounce, self._run_command)
            self._timer.daemon = True
            self._timer.start()
            self._log(f"Scheduled pipeline run in {self.debounce}s")

    def _run_command(self):
        with self._lock:
            self._timer = None
        self._log(f"Running command: {self.command}")
        try:
            res = subprocess.run(self.command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            self._log(f"Command exit={res.returncode}. Output:\n{res.stdout.strip()}")
        except Exception as e:
            self._log(f"Command failed: {e}")

    def on_created(self, event): self._schedule_run()
    def on_modified(self, event): self._schedule_run()
    def on_moved(self, event): self._schedule_run()
    def on_deleted(self, event): self._schedule_run()

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--watchdir", required=True)
    p.add_argument("--pattern", default="*.yang")
    p.add_argument("--cmd", required=True)
    p.add_argument("--debounce", type=float, default=1.0)
    p.add_argument("--logfile", default="/tmp/watcher.log")
    p.add_argument("--use-polling", action="store_true")
    args = p.parse_args()

    watchdir = Path(args.watchdir).resolve()
    if not watchdir.exists():
        print(f"ERROR: watchdir {watchdir} not found", file=sys.stderr)
        sys.exit(2)

    handler = DebouncedHandler(command=args.cmd, debounce=args.debounce,
                               logfile=args.logfile, patterns=[args.pattern], ignore_directories=True)

    # Use PollingObserver with 1 second timeout when --use-polling is specified
    observer = PollingObserver(timeout=1.0) if args.use_polling else Observer()
    if args.use_polling:
        print(f"{now_iso()} Using PollingObserver with timeout=1.0s")

    observer.schedule(handler, str(watchdir), recursive=True)
    observer.start()
    print(f"{now_iso()} Watching {watchdir} pattern={args.pattern} (debounce={args.debounce}s). Press Ctrl-C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        observer.stop()
        observer.join()

if __name__ == "__main__":
    main()
