# mcuemu-web

A static browser interface with English and Russian languages for the WebAssembly build of [mcuemu](https://github.com/devbis/mcuemu). Simulation runs locally in the browser. YAML and firmware images stay on the device in IndexedDB; the web server receives only the static site and WASM files.

## Local development

```sh
npm ci
npm run dev
```

To run the simulator, place `mcuemu-wasm.mjs` and `mcuemu-wasm.wasm` in `public/wasm/`. These files are published by the `wasm.yml` workflow in `devbis/mcuemu`.

Useful checks:

```sh
npm test
npm run check
npm run build
```

## Publish to GitHub Pages

1. Add the repository secret `MCUEMU_ACTIONS_READ_TOKEN` to `devbis/mcuemu-web`. It needs read-only `Actions: read` access to `devbis/mcuemu`.
2. In the repository settings, select **GitHub Actions** as the GitHub Pages source.
3. Push changes to the `main` branch or run `Publish GitHub Pages` manually.

The workflow downloads the latest successful `mcuemu-wasm` artifact from the `wasm.yml` workflow on the `wasm` branch, builds the site with the `/mcuemu-web/` base path, and publishes it. The token is used only in GitHub Actions and is never included in browser-accessible files.

## Block-based bench

On the **Bench** tab, build a lab setup from CPU blocks. Select a model and firmware image for each CPU. Each CPU can contain multiple hardware UART monitors, a soft UART with a manually selected baud rate and GPIO pins for TX/RX, and buttons or switches connected to GPIO. The reference baud rate for a hardware UART does not change the firmware peripheral settings.

UART output is grouped in the event feed: printable UTF-8 appears as lines, while binary data is shown in HEX chunks after a pause in transmission. ANSI log colors are stripped. A partial line appears after a pause or when simulation stops; large binary streams are split into chunks. Events are ordered from oldest to newest, and new output scrolls into view while the feed is at the bottom.

Scenario blocks specify the delay after the previous step and an action: send HEX bytes to a hardware UART, send text bit by bit through a soft UART, or press/release a GPIO. Actions are scheduled in virtual time after the MCU starts. Buttons and switches can also be operated manually during simulation. CPU, UART/GPIO device, radio, and scenario blocks can be edited as YAML and switched back to the visual editor after changes are applied.

The generator automatically creates nets for selected GPIO pins. Supported 802.15.4 radios can share `air0`; when capture is enabled, a PCAP with virtual timestamps is available after pausing. Wi-Fi, Bluetooth, and Ethernet capture are not connected in this version. Custom systems can be imported from one self-contained YAML file without `include` or Lua scripts. ROM/eFuse/RF calibration dumps and `flash.persist` are not loaded by the browser yet.

Saved emulator configurations appear on the first tab. Open one with **Edit** to change it in the Editor, or use **Run** to start it immediately. **Save** stores changes without starting the simulation; **Run** stores and opens the separate **Simulation** tab. Use **Back to editor** there to return to settings. Each saved emulator keeps its own ID, so editing and saving or running it updates that same list entry. Firmware images are deduplicated in IndexedDB by content; logs remain in memory only.

The Editor switches between functional bench blocks and the complete YAML document. Imported YAML can be edited as a whole or through the structural block editor when valid.

## Interface languages

English is the source locale, and Russian is available in the language picker. Locale catalogs map English UI phrases to translated phrases; dynamic phrases can use `{name}` placeholders. Register another catalog in `src/locales/index.ts`; the picker appears automatically when at least two locales are registered, and its selection is saved locally. User-provided names, YAML, endpoint values, and event payloads are kept as entered.
