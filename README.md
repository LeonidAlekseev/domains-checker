# domains-checker

**🇬🇧 English** | [🇷🇺 Русский](README.ru.md)

[![CI](https://github.com/LeonidAlekseev/domains-checker/actions/workflows/ci.yml/badge.svg)](https://github.com/LeonidAlekseev/domains-checker/actions/workflows/ci.yml)
[![JSR](https://jsr.io/badges/@leonidalekseev/domains-checker)](https://jsr.io/@leonidalekseev/domains-checker)
[![GitHub release](https://img.shields.io/github/v/release/LeonidAlekseev/domains-checker)](https://github.com/LeonidAlekseev/domains-checker/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)](https://github.com/LeonidAlekseev/domains-checker/releases)
[![Deno](https://img.shields.io/badge/deno-2.x-black?logo=deno)](https://deno.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A TypeScript/Deno command-line tool for bulk-checking which domains are free, in `.ru` and any other zone with RDAP. It
generates names from a mask and checks them: first quickly over DNS, then the rest through whois.ru or RDAP. No `dig` or
`curl` needed.

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
- 🔎 **whois / RDAP for the rest**: `whois.ru` for `.ru`, RDAP (IANA bootstrap) for other zones, to catch registered
  domains with no NS answer.
- 🌍 **Any zone**: `--tld ru,com,app`; Cyrillic names and zones (`рф`) work.
- 🔁 **Retries**: a whois request is retried up to 3 times; names that still fail are marked `ERR`.
- 📦 **Single binary**: builds for Linux, macOS and Windows.

## Installation

```sh
# Option 1: pre-built binary from the releases page
#   https://github.com/LeonidAlekseev/domains-checker/releases
#   put it on your PATH as domains-checker

# Option 2: from JSR (needs Deno 2+)
deno install -g -n domains-checker --allow-net --allow-env=CONS,VOWS,WHOIS_P --allow-read=/dev/tty,CONIN$ \
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
domains-checker check [--tld ru,com]  # read names from stdin, print one result line per domain
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

Names go to stdin, separated by spaces, commas or newlines. Letters (Cyrillic too), digits and `-` are accepted; case is
ignored, duplicates are dropped. A name without a dot is checked in every `--tld` zone (comma-separated, default `ru`);
a name with a dot (`teef.io`) is checked as is. Requests use punycode, output keeps what you typed.

### Output format

| Line                           | Meaning                                                  |
| ------------------------------ | -------------------------------------------------------- |
| `FREE name.tld`                | unregistered per the registry                            |
| `taken-delegated name.tld`     | taken, NS records exist                                  |
| `taken-whois name.tld (STATE)` | registered per whois.ru, `state:` shown                  |
| `taken-rdap name.tld`          | registered per RDAP                                      |
| `UNKNOWN name.tld`             | the zone has neither whois.ru nor RDAP, cannot check yet |
| `ERR name.tld`                 | no answer — run again for this name                      |

`FREE` means unregistered: premium or reserved names may still be unavailable. `FREE` is never printed without a
registry answer. Lines are sorted. Free names only: `grep ^FREE result.txt`.

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

1. **DNS**: an NS query for the domain through `1.1.1.1`, 40 at a time. An NS answer means the domain is taken
   (`taken-delegated`).
2. **Registry**: everything else — no answer, NXDOMAIN, no NS records or a DNS error — goes to the registry. `.ru` uses
   `whois.ru`: the page says either that the domain is free, or shows its `state:`. Zones in the IANA RDAP bootstrap
   (`data.iana.org/rdap/dns.json`, fetched once per run) use RDAP: 200 is taken, 404 is free, 429 waits `Retry-After`
   and retries. Other zones are `UNKNOWN`. If the bootstrap cannot be loaded, `check` exits with an error.

## Troubleshooting

#### `captcha: whois.ru blocked ...`

whois.ru asked for a captcha. From then on no new whois.ru request starts; results already obtained are kept. Then:

1. If another `--proxy URL` is left, `check` switches to it and continues. `--proxy` is repeatable, applies to whois.ru
   only (DNS is not proxied) and is used one per captcha; the first requests go direct. Schemes: `http://`, `https://`,
   `socks5://`, `socks5h://` (`socks4://` is rejected by Deno).
2. Otherwise, with a terminal, it prints `https://whois.ru/<name>.ru` to stderr. Pass the captcha in a browser, then
   press Enter to continue or `q` + Enter to stop. The prompt reads the controlling terminal (`/dev/tty`, `CONIN$` on
   Windows), so it works in `gen | check`. If the captcha comes back, it asks again.
3. Without a terminal (cron, CI) it stops with a message on stderr.

On stop, names that were not checked are marked `ERR`. This is not guaranteed to help: if whois.ru ties the captcha to
your browser session rather than your IP, passing it in a browser or changing the proxy may change nothing. Then wait,
lower `WHOIS_P` and run again.

#### `ERR name` in the results

whois did not give a usable answer after 3 attempts (timeout, network error or captcha). Feed the `ERR` names back:
`grep ^ERR result.txt | cut -d' ' -f2 | domains-checker check`.

#### `invalid mask …`

The mask allows only `C V D L A` and lowercase letters, digits and `-`.

## FAQ

**Why is `y` a vowel?** In the default sets `V` is `a e i o u y` and `C` is the other 20 letters. Change them with
`VOWS` and `CONS`.

**Does it check other zones?** Yes: `--tld ru,com,app`. Zones without RDAP (for example `.io`, `.me`) are `UNKNOWN` for
now.

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
src/check.ts   DNS, whois and RDAP checks, result parsing
tests/         unit tests
```

Release: bump `version` in `deno.json`, then `git tag v<version> && git push origin v<version>`. CI builds binaries for
Linux, macOS and Windows into a GitHub Release and publishes the package to JSR.

## License

[MIT](LICENSE).
