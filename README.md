# domains-checker

**🇬🇧 English** | [🇷🇺 Русский](README.ru.md)

[![CI](https://github.com/LeonidAlekseev/domains-checker/actions/workflows/ci.yml/badge.svg)](https://github.com/LeonidAlekseev/domains-checker/actions/workflows/ci.yml)
[![JSR](https://jsr.io/badges/@leonidalekseev/domains-checker)](https://jsr.io/@leonidalekseev/domains-checker)
[![GitHub release](https://img.shields.io/github/v/release/LeonidAlekseev/domains-checker)](https://github.com/LeonidAlekseev/domains-checker/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)](https://github.com/LeonidAlekseev/domains-checker/releases)
[![Deno](https://img.shields.io/badge/deno-2.x-black?logo=deno)](https://deno.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A TypeScript/Deno command-line tool for bulk-checking which `.ru` domains are free. It generates names from a mask and
checks them: first quickly over DNS, then the rest through whois. No `dig` or `curl` needed.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [How It Works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Development](#development)
- [License](#license)

## Features

- 🎭 **Masks**: `gen CVCV` prints every matching name, one per line.
- 🔊 **`--nice`**: keeps only names that are easy to read and pronounce.
- ⚡ **DNS first**: an NS query through `1.1.1.1` with 40 parallel requests settles most names.
- 🔎 **whois for the rest**: `whois.ru` catches registered domains that have no NS answer.
- 🔁 **Retries**: a whois request is retried up to 3 times; names that still fail are marked `ERR`.
- 📦 **Single binary**: builds for Linux, macOS and Windows.

## Installation

```sh
# Option 1: pre-built binary from the releases page
#   https://github.com/LeonidAlekseev/domains-checker/releases
#   put it on your PATH as domains-checker

# Option 2: from JSR (needs Deno 2+)
deno install -g -n domains-checker --allow-net=1.1.1.1,whois.ru --allow-env=CONS,VOWS,WHOIS_P \
  jsr:@leonidalekseev/domains-checker

# Option 3: from source (needs Deno 2+)
git clone https://github.com/LeonidAlekseev/domains-checker
cd domains-checker
deno task compile                 # → dist/domains-checker
# or run without building:
deno task start --help
```

> [!NOTE]
> Deno does not install versions published less than 24 hours ago by default. If a fresh release is rejected, add
> `--minimum-dependency-age=0` to the install command.

## Quick Start

```sh
echo "teef zvom" | domains-checker check
domains-checker gen CVCV --nice | domains-checker check > result.txt
grep ^FREE result.txt
```

## Usage

```sh
domains-checker gen MASK [--nice]   # print names matching the mask
domains-checker check               # read names from stdin, print one result line per name
domains-checker --help              # also: --version
```

### Mask

| Symbol                | Meaning                                 |
| --------------------- | --------------------------------------- |
| `C`                   | consonant                               |
| `V`                   | vowel                                   |
| `D`                   | digit `0-9`                             |
| `L`                   | letter `a-z`                            |
| `A`                   | any of `a-z`, `0-9`, `-`                |
| lowercase, digit, `-` | itself (for example, `shop` or `CVC-D`) |

Names that `.ru` does not allow are skipped: shorter than 2 or longer than 63 characters, a leading or trailing `-`, or
`--` at positions 3–4. `gen` prints a warning on stderr when a mask yields more than a million combinations.

### `--nice`

Keeps only pronounceable names. Each letter part of a name (digits and `-` split it) must have a vowel, no banned
letters (`q x w j c y` — so `y` never passes, although it counts as a vowel elsewhere), no doubled letters, at most two
consonants or two vowels in a row, and only common consonant clusters such as `st`, `br`, `nd`. Everything is defined in
`src/nice.ts`.

### Input of `check`

Names go to stdin without `.ru`, separated by spaces, commas or newlines. Only `a-z`, `0-9` and `-` are accepted; case
is ignored, duplicates are dropped.

### Output format

| Line                       | Meaning                                        |
| -------------------------- | ---------------------------------------------- |
| `FREE name`                | the domain is free                             |
| `taken-delegated name`     | taken, NS records exist                        |
| `taken-whois name (STATE)` | registered per whois, `state:` shown           |
| `ERR name`                 | whois did not answer — run again for this name |

Lines are sorted. Free names only: `grep ^FREE result.txt`.

### Environment variables

| Variable  | Default              | Description                                                                                          |
| --------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `WHOIS_P` | `2`                  | parallel whois requests. whois.ru shows a captcha after several thousand fast requests — keep it low |
| `CONS`    | the other 20 letters | consonants for `C`, space-separated                                                                  |
| `VOWS`    | `a e i o u y`        | vowels for `V`, space-separated                                                                      |

```sh
CONS="b d l m n r t v" VOWS="a o e i" domains-checker gen CVCVC | domains-checker check
```

## How It Works

1. **DNS**: an NS query for `name.ru` through `1.1.1.1`, 40 at a time. An NS answer means the domain is taken
   (`taken-delegated`).
2. **whois**: everything else — no answer, NXDOMAIN, no NS records or a DNS error — is checked through `whois.ru`. The
   page says either that the domain is free, or shows its `state:`.

## Troubleshooting

#### `captcha: whois.ru blocked, stop and retry later`

whois.ru asked for a captcha. Stop, wait, lower `WHOIS_P`, and run again; names that were not checked are marked `ERR`.

#### `ERR name` in the results

whois did not give a usable answer after 3 attempts (timeout, network error or captcha). Feed the `ERR` names back:
`grep ^ERR result.txt | cut -d' ' -f2 | domains-checker check`.

#### `invalid mask …`

The mask allows only `C V D L A` and lowercase letters, digits and `-`.

## FAQ

**Why is `y` a vowel?** In the default sets `V` is `a e i o u y` and `C` is the other 20 letters. Change them with
`VOWS` and `CONS`.

**Does it check other zones?** No, only `.ru`.

**Why check DNS before whois?** It is fast and has no captcha. whois.ru is slower and limited, so it only gets the names
DNS could not settle.

## Development

```sh
deno task check     # fmt, lint, type check
deno task test      # unit tests
deno task start     # run from source
deno task compile   # build dist/domains-checker
```

Layout:

```
src/main.ts    CLI: arguments, help, gen and check commands
src/gen.ts     mask expansion and .ru name rules
src/nice.ts    the --nice heuristic
src/check.ts   DNS and whois checks, result parsing
tests/         unit tests
```

Release: bump `version` in `deno.json`, then `git tag v<version> && git push origin v<version>`. CI builds binaries for
Linux, macOS and Windows into a GitHub Release and publishes the package to JSR.

## License

[MIT](LICENSE).
