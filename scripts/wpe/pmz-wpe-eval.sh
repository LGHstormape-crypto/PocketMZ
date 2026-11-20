#!/bin/sh
# Run JavaScript in the page of a running pmz-wpe-run.sh (REPL 127.0.0.1:9333) and print the result.
# Usage: pmz-wpe-eval.sh '<js expression>'
curl -s -m "${PMZ_WPE_TIMEOUT:-30}" --data-binary "$*" 127.0.0.1:9333; echo
