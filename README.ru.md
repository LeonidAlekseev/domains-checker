# domains-checker

[🇬🇧 English](README.md) | **🇷🇺 Русский**

[![CI](https://github.com/LeonidAlekseev/domains-checker/actions/workflows/ci.yml/badge.svg)](https://github.com/LeonidAlekseev/domains-checker/actions/workflows/ci.yml)
[![JSR](https://jsr.io/badges/@leonidalekseev/domains-checker)](https://jsr.io/@leonidalekseev/domains-checker)
[![GitHub release](https://img.shields.io/github/v/release/LeonidAlekseev/domains-checker)](https://github.com/LeonidAlekseev/domains-checker/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)](https://github.com/LeonidAlekseev/domains-checker/releases)
[![Deno](https://img.shields.io/badge/deno-2.x-black?logo=deno)](https://deno.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Консольный инструмент на TypeScript/Deno для массовой проверки свободных доменов `.ru`. Генерирует имена по маске и
проверяет их: сначала быстро через DNS, затем оставшиеся через whois. Не нужны ни `dig`, ни `curl`.

## Содержание

- [Возможности](#возможности)
- [Установка](#установка)
- [Быстрый старт](#быстрый-старт)
- [Использование](#использование)
- [Как работает](#как-работает)
- [Решение проблем](#решение-проблем)
- [FAQ](#faq)
- [Разработка](#разработка)
- [Лицензия](#лицензия)

## Возможности

- 🎭 **Маски**: `gen CVCV` печатает все подходящие имена по одному в строке.
- 🔊 **`--nice`**: оставляет только имена, которые легко читать и произносить.
- ⚡ **Сначала DNS**: NS-запрос через `1.1.1.1`, 40 запросов параллельно, закрывает большинство имён.
- 🔎 **whois для остальных**: `whois.ru` находит зарегистрированные домены без NS-ответа.
- 🔁 **Повторы**: запрос к whois повторяется до 3 раз; имена, которые так и не проверились, помечаются `ERR`.
- 📦 **Один бинарник**: сборки для Linux, macOS и Windows.

## Установка

```sh
# Вариант 1: готовый бинарник со страницы релизов
#   https://github.com/LeonidAlekseev/domains-checker/releases
#   положите в PATH под именем domains-checker

# Вариант 2: из JSR (нужен Deno 2+)
deno install -g -n domains-checker --allow-net=1.1.1.1,whois.ru --allow-env=CONS,VOWS,WHOIS_P \
  jsr:@leonidalekseev/domains-checker

# Вариант 3: из исходников (нужен Deno 2+)
git clone https://github.com/LeonidAlekseev/domains-checker
cd domains-checker
deno task compile                 # → dist/domains-checker
# или запуск без сборки:
deno task start --help
```

> [!NOTE]
> Deno по умолчанию не ставит версии, опубликованные меньше 24 часов назад. Если свежий релиз не ставится, добавьте к
> команде установки `--minimum-dependency-age=0`.

## Быстрый старт

```sh
echo "teef zvom" | domains-checker check
domains-checker gen CVCV --nice | domains-checker check > result.txt
grep ^FREE result.txt
```

## Использование

```sh
domains-checker gen MASK [--nice]   # напечатать имена по маске
domains-checker check               # читать имена из stdin, печатать по строке результата на имя
domains-checker --help              # также: --version
```

### Маска

| Символ                     | Значение                              |
| -------------------------- | ------------------------------------- |
| `C`                        | согласная                             |
| `V`                        | гласная                               |
| `D`                        | цифра `0-9`                           |
| `L`                        | буква `a-z`                           |
| `A`                        | любой из `a-z`, `0-9`, `-`            |
| строчная буква, цифра, `-` | он сам (например, `shop` или `CVC-D`) |

Имена, недопустимые в `.ru`, пропускаются: короче 2 или длиннее 63 символов, `-` в начале или конце, `--` на позициях
3–4. Если маска даёт больше миллиона комбинаций, `gen` пишет предупреждение в stderr.

### `--nice`

Оставляет только произносимые имена. Каждая буквенная часть имени (цифры и `-` разделяют части) должна содержать
гласную, не содержать запрещённых букв (`q x w j c y`) и удвоенных букв, иметь не больше двух согласных или двух гласных
подряд и только распространённые сочетания согласных вроде `st`, `br`, `nd`. Все правила — в `src/nice.ts`.

### Ввод `check`

Имена подаются в stdin без `.ru`, через пробел, запятую или перевод строки. Принимаются только `a-z`, `0-9` и `-`;
регистр игнорируется, дубликаты отбрасываются.

### Формат вывода

| Строка                     | Значение                                       |
| -------------------------- | ---------------------------------------------- |
| `FREE name`                | домен свободен                                 |
| `taken-delegated name`     | занят, есть NS-записи                          |
| `taken-whois name (STATE)` | занят по whois, показан `state:`               |
| `ERR name`                 | whois не ответил — перезапустите для этих имён |

Строки отсортированы. Только свободные: `grep ^FREE result.txt`.

### Переменные окружения

| Переменная | По умолчанию      | Описание                                                                                                          |
| ---------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `WHOIS_P`  | `2`               | параллельных запросов к whois. whois.ru показывает капчу после нескольких тысяч быстрых запросов — держите низким |
| `CONS`     | остальные 20 букв | согласные для `C`, через пробел                                                                                   |
| `VOWS`     | `a e i o u y`     | гласные для `V`, через пробел                                                                                     |

```sh
CONS="b d l m n r t v" VOWS="a o e i" domains-checker gen CVCVC | domains-checker check
```

## Как работает

1. **DNS**: NS-запрос для `name.ru` через `1.1.1.1`, по 40 одновременно. Пришёл NS-ответ — домен занят
   (`taken-delegated`).
2. **whois**: всё остальное — нет ответа, NXDOMAIN, нет NS-записей или ошибка DNS — проверяется через `whois.ru`.
   Страница сообщает, что домен свободен, либо показывает его `state:`.

## Решение проблем

#### `captcha: whois.ru blocked, stop and retry later`

whois.ru потребовал капчу. Остановитесь, подождите, уменьшите `WHOIS_P` и запустите снова; непроверенные имена помечены
`ERR`.

#### `ERR name` в результатах

whois не дал внятного ответа за 3 попытки (таймаут, ошибка сети или капча). Скормите `ERR`-имена обратно:
`grep ^ERR result.txt | cut -d' ' -f2 | domains-checker check`.

#### `invalid mask …`

В маске допустимы только `C V D L A`, строчные буквы, цифры и `-`.

## FAQ

**Почему `y` — гласная?** По умолчанию `V` — это `a e i o u y`, а `C` — остальные 20 букв. Меняется через `VOWS` и
`CONS`.

**Проверяет ли другие зоны?** Нет, только `.ru`.

**Почему DNS перед whois?** Он быстрый и без капчи. whois.ru медленнее и ограничен, поэтому ему достаются только имена,
которые DNS не решил.

## Разработка

```sh
deno task check     # fmt, lint, проверка типов
deno task test      # unit-тесты
deno task start     # запуск из исходников
deno task compile   # сборка dist/domains-checker
```

Структура:

```
src/main.ts    CLI: аргументы, справка, команды gen и check
src/gen.ts     раскрытие маски и правила имён .ru
src/nice.ts    эвристика --nice
src/check.ts   проверки DNS и whois, разбор ответа
tests/         unit-тесты
```

Релиз: поднять `version` в `deno.json`, затем `git tag v<version> && git push origin v<version>`. CI соберёт бинарники
для Linux, macOS и Windows в GitHub Release и опубликует пакет в JSR.

## Лицензия

[MIT](LICENSE).
