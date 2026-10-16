# Slopsmith Plugin: Piano Highway

A plugin for [Slopsmith](https://github.com/got-feedback/feedback) that replaces the guitar highway with a Synthesia-style scrolling piano view, with MIDI keyboard input and a built-in software synthesizer.

![Piano Highway](screenshot.png)

## Features

- **Scrolling piano view** — notes fall from top to bottom onto a rendered keyboard, Synthesia/Openthesia-style
- **Neon rainbow colors** — each chromatic pitch gets a unique neon color with multi-layer glow effects
- **Polished keyboard** — 3D gradient shading, rounded corners, press-down animation, and approach color lerping as notes get closer
- **Dynamic zoom** — keyboard auto-scales to show only the octaves with active notes, snapping in clean octave steps
- **Auto-activate** — picked automatically in the **Auto** visualization mode for Keys/Piano/Synth arrangements
- **MIDI keyboard input** — connect any USB MIDI keyboard via Web MIDI API to play along
- **Hit/miss feedback** — keys glow green for correct notes, blue for freestyle, red for wrong notes
- **Built-in synthesizer** — WebAudioFont-powered playback with 10 GM instruments (Grand Piano, Electric Piano, Organ, Strings, Synth, and more)
- **Accuracy scoring** — optional hit detection with accuracy %, streak counter, and best streak tracking
- **Sustain pedal** — full MIDI CC#64 sustain pedal support
- **Inline settings** — MIDI device, instrument, volume, channel, transpose, and toggles all accessible from the player

## Requirements

- **Chrome or Edge** for MIDI keyboard input (Firefox does not support Web MIDI)
- MIDI features are optional — the piano view works without a MIDI keyboard

## Installation

```bash
cd /path/to/slopsmith/plugins
git clone https://github.com/got-feedback/feedback-plugin-piano.git piano
docker compose restart
```

Piano Highway is also bundled with the feedBack Desktop app.

## Usage

Piano Highway is a visualization, so it replaces the highway instead of adding a button.

1. Play a song.
2. Open the visualization picker (**Visualization & quality** on the player rail) and choose **Piano Highway**. With **Auto (match arrangement)** selected, it is picked automatically for Keys, Piano, Keyboard or Synth arrangements. Notation-only arrangements are left to the notation visualizations (Staff View, Keys Highway 3D).
3. While Piano Highway is active, a ⚙ gear button opens the MIDI input and sound settings. In the v3 UI the gear sits in the **Plugin controls** popover on the player rail. Under splitscreen it sits in each panel's bar.
4. Pick another visualization (for example **Classic 2D Highway**) to switch back.

## How It Works

The plugin reads note data from the highway renderer and draws them as colored bars falling onto a piano keyboard. Notes use the MIDI encoding convention `midi = string * 24 + fret`, which the [editor plugin](https://github.com/got-feedback/feedback-plugin-editor) uses when importing keyboard tracks from Guitar Pro files.

For any guitar arrangement, the piano view shows the notes mapped to their MIDI pitch positions, which can be a useful alternative visualization even for guitar parts.

### MIDI Keyboard

Connect a USB MIDI keyboard and select it from the settings panel. Play along and get real-time visual feedback:

- **Green keys** — you hit the correct note at the right time
- **Blue keys** — you're playing freely (no matching song note)
- **Red flash** — wrong note
- **Approach glow** — keys light up with the note's color as it approaches the now line

### Instruments

Select from 10 General MIDI sounds via the settings panel:

| Sound | GM Program |
|-------|-----------|
| Grand Piano | 0 |
| Electric Piano | 4 |
| Honky-tonk | 3 |
| Organ | 19 |
| Strings | 48 |
| Synth Lead | 80 |
| Synth Pad | 88 |
| Harpsichord | 6 |
| Vibraphone | 11 |
| Music Box | 10 |

## License

MIT
