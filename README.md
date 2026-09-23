# Bastion of Blasphemies Companion

[简体中文](README.zh-CN.md)

GM tools for running *Bastion of Blasphemies* in PF2e.

- Apply chapter-based day, night and weather modifiers.
- Confirm Party rests and resolve nightmare saves.
- Track boons, cooldowns, foul air and tower lightning.
- Use soulhearts with a single selection and preview form.
- Sync chapter weather with an existing Calendaria setup.

## Requirements

Tested with Foundry VTT **14.368**, PF2e **8.5.1** and libWrapper **1.13.5.1+**. The official adventure **1.0.0** supplies the items and rules used by the adventure tools. Those tools require its imported world content. Environment rules can also use a manually selected chapter.

Calendaria **1.4.2** is optional. Sync requires the existing BoB calendar zones and weather presets; the module does not create a calendar.

## Install

In Foundry's module installer, paste this manifest URL:

```text
https://github.com/takaqiao/pf2e-bob-companion/releases/latest/download/module.json
```

Enable the module and libWrapper, then reload. Open **BoB adventure tools** in Module Settings, or use **Adventure tools** from the environment panel in the Actors directory.

## First use

1. In the environment panel, check the chapter and clock. Under **Scene setup**, include your map and mark indoor or sheltered Regions. The official main island is included by default.
2. Under **Rest → Advanced**, set whether the campaign's previous first nights have already been handled. Party rests then appear for confirmation.
3. Bind hazard Regions and the boon room before using their automatic tracking.
4. For an existing campaign, check the soulheart HP total under **Soulhearts → Advanced**. New characters can receive the party's existing reward there.

Soulheart actions show the actual item, phantom rank and each recipient's HP change before applying them. Recovery and corrections are under Advanced. Use a pending operation's retry action after a failed write.

The GM confirms story prerequisites, actual exposure, counteract checks and damage. Players see their current rolls and effects. Research continues in the existing adventure scene.

## Languages

English and Simplified Chinese follow each client's Foundry language. Chinese supports both `cn` and `zh-cn`. Module-created effect names, descriptions and marked chat messages render in each viewer's language. User-created names and other packages' content keep their own translations. Existing chat history keeps its saved text.

## Settings and performance

The environment panel has Overview, Scene setup and Advanced tabs. Ordinary movement within the same environment does not reprepare actors. Normal clock ticks do not save hazard records unless a boundary changes. No frame loop or polling is added.

Pausing environment rules also pauses automatic rest intake, hazard tracking and conditional boon updates. It keeps completed rewards and records. Saved items and effects remain when the module is disabled; remove them when their in-game conditions end.

Calendaria sync preserves manual weather until the next chapter or until the GM resumes sync. It uses the existing world clock and leaves scene visuals and sound to the adventure.

## Development

Run tests with `node --test tests/*.test.mjs`. Build a release in PowerShell with `./build.ps1`. The archive contains the runtime, languages, documentation and three optional macro scripts. Tests and adventure assets are excluded.

[Changes](CHANGELOG.md) · [Issues](https://github.com/takaqiao/pf2e-bob-companion/issues)

## License

Code is available under the [MIT License](LICENSE). This is an unofficial companion module. Foundry VTT, Pathfinder and Bastion of Blasphemies belong to their respective owners. The module does not include the commercial adventure, maps, artwork or compendium packs.
