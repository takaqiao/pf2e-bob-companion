# Bastion of Blasphemies Companion

[简体中文](README.zh-CN.md)

GM tools for PF2e's *Bastion of Blasphemies*: chapter weather, rests and nightmares, boons, hazards and soulhearts

Open **BoB adventure tools** in Module Settings, or **Adventure tools** from the environment panel in the Actors directory

## Install

Paste this into Foundry's module installer:

```text
https://github.com/takaqiao/pf2e-bob-companion/releases/latest/download/module.json
```

Enable the module and libWrapper, then reload

Tested with Foundry VTT **14.368**, PF2e **8.5.1** and libWrapper **1.13.5.1+**. Adventure tools require the imported content from the official adventure **1.0.0**; environment rules also support a manually selected chapter

Optional: Calendaria **1.4.2** with existing BoB chapter zones and weather presets

## First use

1. Check the chapter and clock. Under **Scene setup**, include your map and mark sheltered Regions; the official main island is included by default
2. Open **Rest and nightmares** and record whether previous first nights have been handled
3. Bind hazard Regions and the boon room
4. For an existing campaign, check the HP total under **Soulhearts → Advanced**; new characters can receive the existing reward there

## Use

| Tool | Action |
| --- | --- |
| Rest and nightmares | Confirm who slept, then resolve saves |
| Boons | Record use, check cooldowns, and finish pending checks under Records and follow-up |
| Hazards | Check exposure, shelter and immunity, then roll or record results |
| Soulhearts | Choose a purpose and confirm the quantity, rank and HP changes |

Corrections and recovery are under **Advanced**. Continue an existing entry if a soulheart operation is interrupted. The GM confirms story prerequisites, counteract results and damage

Pausing rules keeps rewards and records while pausing rest capture, hazard tracking and conditional boon updates. Disabling the module keeps saved items and effects; remove them when their story conditions end

Calendaria keeps manual weather until the next chapter or until you resume automatic sync

English and Chinese follow each client's language, including `cn` and `zh-cn`. Existing chat keeps its saved text

## Development

Tests: `node --test tests/*.test.mjs`

Build: `./build.ps1` in PowerShell

[Changes](CHANGELOG.md) · [Issues](https://github.com/takaqiao/pf2e-bob-companion/issues)

[MIT License](LICENSE). Unofficial companion module; names and adventure content belong to their respective owners. The archive contains no commercial adventure, maps, artwork or compendium packs
