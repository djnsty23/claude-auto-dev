#!/bin/bash
# Quick resume for Claude Code sessions
# Usage: cr              # Resume latest / open picker
#        cr feature      # Resume session matching "feature"
#        cr abc123       # Resume specific session ID

claude -p --resume "$@"
