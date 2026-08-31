#!/bin/bash

set -e

cd "$(dirname -- "${BASH_SOURCE[0]}")" || exit 1

git pull

npm ci --ignore-scripts --legacy-peer-deps

pi install "$(pwd)"
