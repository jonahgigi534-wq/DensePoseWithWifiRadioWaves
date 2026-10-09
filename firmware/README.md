# ESP32 CSI node firmware

This is the ESP32 CSI node firmware from [RuView](https://github.com/ruvnet/RuView) (v0.7.0, MIT license), included without changes. It runs on an ESP32-S3, captures WiFi Channel State Information (CSI) from your router and sends it to the backend over UDP.

## Why v0.7.0

An older RuView build (v0.4.3.1) only let data from one node through. Starting the WiFi driver overwrote the node ID stored in flash, so every board reported itself as node 1 and the backend treated them all as one sensor. v0.7.0 reads the node ID before WiFi starts (`csi_collector_set_node_id()`, called from `main/main.c`), so each board keeps its own ID. Running more than one node depends on this, and so does position estimation.

## Flashing the prebuilt images

`prebuilt/` has a v0.7.0 build for an ESP32-S3 with 8 MB of flash (built with ESP-IDF v5.4). Install esptool with `pip install esptool`, then from this folder:

```bash
python -m esptool --chip esp32s3 --port COM7 --baud 460800 \
  write_flash --flash_mode dio --flash_size 8MB \
  0x0     prebuilt/bootloader.bin \
  0x8000  prebuilt/partition-table.bin \
  0xf000  prebuilt/ota_data_initial.bin \
  0x20000 prebuilt/esp32-csi-node.bin
```

Replace `COM7` with your board's port (`/dev/ttyUSB0` on Linux). The offsets come from `partitions_display.csv`.

## Building from source

You need [ESP-IDF v5.4](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32s3/get-started/). On Windows, run these from the ESP-IDF PowerShell or Command Prompt shortcut. `idf.py` refuses to run under Git Bash.

```bash
idf.py set-target esp32s3
idf.py build
idf.py -p COM7 flash
```

`build_firmware.ps1` does the same from any PowerShell window once the ESP-IDF environment is loaded (it clears the MSYS variables that make `idf.py` quit). Add `-Port COM7` to flash after building. `build_firmware.bat` is the Command Prompt version.

## Provisioning

WiFi credentials and the backend's address live in the board's NVS storage, so changing them doesn't need a rebuild:

```bash
pip install "esptool>=5.0" nvs-partition-gen
python provision.py --port COM7 --ssid "YourWiFi" --password "YourPassword" \
  --target-ip 192.168.1.20 --target-port 5005 --node-id 1
```

`--target-ip` is the LAN address of the PC running the backend, which listens on UDP 5005. Give each board its own `--node-id`.

By default a node stays on your router's channel. Don't use `--hop-channels`: channel hopping looks like motion to the backend and causes false presence.

To watch a board's log: `python -m serial.tools.miniterm COM7 115200`.

## Packets

Each UDP packet starts with a 4-byte little-endian magic number.

| Magic | Size | Contents | Backend uses it for |
|---|---|---|---|
| `0xC5110001` | 20-byte header + I/Q data | Raw CSI. Node ID at byte 4, subcarrier count at bytes 6-7, RSSI at byte 16, then one int8 I and Q pair per subcarrier | Presence, motion, RSSI |
| `0xC5110002` | 32 bytes | Vitals: flags at byte 5, breathing rate x100 at bytes 6-7, heart rate x10000 at bytes 8-11, RSSI at byte 12 | Breathing and heart rate readout |
| `0xC5110003` | 48 bytes | Eight float32 summary features from byte 16 | RSSI, motion, person count |
| `0xC5110004` | 48 bytes | Vitals merged with a 60 GHz mmWave sensor, sent only if one is attached | Not used yet |

The firmware's own breathing and heart rate estimates aren't reliable. See the main [README](../README.md#limitations).

## License

MIT, from RuView. See [LICENSE](../LICENSE).
