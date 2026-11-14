# Damage tracker patch-upgrade guide

Use this guide when the Damage tab reports an unsupported build or a League
patch changes damage, target classification, source labels, or Death Recap.
The reference build is **16.22.8348910**. See the
[research log](damage-tracker-research.md) for the original experiments and
known gaps. Keep the shipped build check in
[`damageWire.js`](../src/core/damageWire.js) exact until the new build passes
both offline decoding checks and a live capture comparison.

## Confirm the build and capture a baseline

1. Read the installed Windows file version, then confirm it against the
   matching game's original `*_r3dlog.txt` header. The current gate normalizes
   `16.22.834.8910` to `16.22.8348910`. Use the exact build, including hotfix
   digits.

   ```powershell
   (Get-Item 'C:\Riot Games\League of Legends\Game\League of Legends.exe').VersionInfo |
     Select-Object FileVersion, ProductVersion
   ```

2. Use **Damage → Start tracking** or run `node scripts/record-damage.mjs`.
   Wait for **Recorder ready** before launching the match. Keep
   `raw-ipv4.pcapng`, `observations.jsonl`, and `original-r3dlog.txt`
   together. For an unsupported build, use a private capture-only copy of
   [`scripts/record-damage.mjs`](../scripts/record-damage.mjs) under
   `.local-research/`. Skip live decoding in that copy and keep log discovery
   active so finalization can save the original log.

3. In Practice Tool or a custom game, record isolated autos and spells against
   a champion or bot, a dummy, and a neutral monster. Include true damage,
   a shielded or lethal hit, and a death with a visible Fight Duration. Save
   the displayed numbers and approximate times. Then record a full match
   from loading through the results screen. Save Match History totals and
   damage types for both scopes. Keep logs, packets, binaries, screenshots
   with player names, and private reports outside tracked files.

## Adapt the decoder

Use the exact official macOS build as an offline reference when the Windows
executable is protected. Find the matching macOS game-client manifest under
`LoL/EUW1/macos/lol-game-client/` in the
[riot-manifests registry](https://github.com/Morilli/riot-manifests). Extract
`LeagueofLegends.app/Contents/MacOS/LeagueofLegends` and `code-metadata.json`
from Riot's CDN using [CDTB](https://github.com/CommunityDragon/CDTB),
verify the build, and pin the
full executable's SHA-256. Use the x86-64 slice with
[`damage_oracle_16_22.py`](../research/damage_oracle_16_22.py) as the model
for the new offline oracle. Rediscover the factory, deserializers and
consumers, then port the verified layouts into a build-specific JavaScript
reader using [`damagePacketFields16_22.js`](../src/core/damagePacketFields16_22.js)
as the reference. Preserve the 16.22 tests and keep the shipped decoder
standalone.

Work in this order. The packet IDs below are **16.22 references**.

| Layer | What to verify |
| --- | --- |
| Transport | Check decryption and checksum before interpreting application fields. Verify framing, compressed messages, fragment reassembly, and nested batches (1045). Compare acknowledgment gaps, rejected datagrams, and incomplete fragments. PktMon missed acknowledged hits in controlled tests. The Windows IP-layer capture recovered them. |
| Ownership and targets | Verify local ownership from an outgoing action (618). Match hero spawn IDs and models (43) to the opening Live Client Data roster. Check that late starts show partial coverage and that dummy, minion, and neutral hits stay out of the Champions view. |
| Damage | Follow the 743 event to its damage-counter consumer. Verify the schema, directions (24 received, 25 dealt), endpoints and physical, magic, and true floats. Compare exact byte consumption and fields with the native reader. Damage includes reported overkill. Matched HP loss is a separate metric using health replication (952) and display events (393). Those display events have insufficient coverage for team totals. |
| Death Recap | Follow 1074 to the Fight Duration field and the separate outgoing entry. In 16.22 the consumer at `0x100bd5cb0` handles that entry. Check the three damage schools and confirm rounding each detail up before summing. Match the local hero update (419), including adjacent datagrams. Compare the displayed duration and outgoing damage against League. The 10-second configurable pause and 45-second limit are live estimates. |
| Source labels | Verify the 96-byte body's root, applying script, and missile hashes (offsets 80, 16, and 48). Check lowercase ELF spell hashes and the FNV-1a item and perk origin markers. A zero root can still identify a burn or augment via the script hash. Check shared augment scripts against mode data and the local player's actual selected augments. A script name alone can mislabel a shared effect. The LCU item catalog covers sold items. Unknown names should remain grouped without changing totals. |

For source-name changes, use
[`research/damageSourceNames16_22.mjs`](../research/damageSourceNames16_22.mjs)
as the template. The existing command below overwrites the **16.22** shared
list. Give a new-build generator its own output filename and build label.

```powershell
node research/damageSourceNames16_22.mjs 'C:\Riot Games\League of Legends'
```

## Verify and record the result

```powershell
py -3.13 -m venv .venv-research
.venv-research/Scripts/python.exe -m pip install -r research/requirements-ff.txt
$env:DAMAGE_MACOS_BINARY_16_22 = '.local-research/official-builds/9E817EA717DA1A6F-LeagueofLegends'
.venv-research/Scripts/python.exe -m unittest discover -s research -p test_damage_oracle_16_22.py
.venv-research/Scripts/python.exe research/damage_capture_16_22.py --session '<16.22-session>' --raw-only --binary $env:DAMAGE_MACOS_BINARY_16_22 --output '.local-research/new-16-22-report.json'
npm test
```

Use the equivalent new-build tests and analyzer for the upgrade. Match the
native reader on real payloads and keep synthetic fixtures for malformed
inputs. Replay the saved samples through the app decoder in timestamp order.
Compare the **last live totals** and damage-type subtotals with the same
player's Match History stats at League's integer precision. Truncation
matched the saved ARAM captures. Compare the pre-death estimate with each
decoded recap, including how many matched and
where it was off. The post-game card can replace live totals with official
numbers, so check the live value directly.

Smoke-test the narrow Damage tab with the two cards, target switch, HP loss
toggle, and source breakdowns. Record the build, test modes, matched totals,
recap coverage and any remaining gaps in the research log. Keep unverified
builds unavailable and unverified fields visibly partial or unknown.
