#!/usr/bin/env bash
# HyperVeil, HyperEVM side.
set -e
cd "$(dirname "$0")/.."
echo "=== contracts: compile ==="
(cd script && node build.js)
echo "=== wire format (vectors shared with hyperveil/starknet) ==="
(cd test && node codec.test.js)
echo "=== omnibus ==="
(cd test && node omnibus.test.js)
echo "=== relay endpoint (testnet stand-in for LayerZero) ==="
(cd test && node relay.test.js)
