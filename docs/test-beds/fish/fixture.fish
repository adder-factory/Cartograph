#!/usr/bin/env fish
# Fish test bed — functions and a call between them.

set -g greeting hello

function greet
    echo "$greeting $argv[1]"
end

function main
    greet world
end

main
