#!/bin/bash
# Generate all names for a mask. C = consonant, V = vowel, any other char is kept literally.
# Letter sets via env (defaults = unambiguous ru<->lat letters):
#   CONS="b d f l m n p r t v z"  VOWS="a o e"
# Usage: ./gen.sh CVCV      CONS="b d l m n r t v" VOWS="a o e i" ./gen.sh CVCVC
CONS=${CONS:-"b d f l m n p r t v z"}; VOWS=${VOWS:-"a o e"}
[ -n "$1" ] || { echo "usage: $0 MASK (e.g. CVCV)" >&2; exit 1; }
out=("")
for ((i=0; i<${#1}; i++)); do ch=${1:i:1}
  case $ch in C) set_=$CONS;; V) set_=$VOWS;; *) set_=$ch;; esac
  next=(); for p in "${out[@]}"; do for l in $set_; do next+=("$p$l"); done; done; out=("${next[@]}")
done
printf '%s\n' "${out[@]}"
