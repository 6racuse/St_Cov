# Telecom Map Tool

Standalone Leaflet-based map for telecom market analysis.

## Files
- `index.html` - Map entry point
- `styles.css` - UI styling
- `app.js` - Map interactions and country/operator toggles
- `build_map.py` - Python preprocessing and data export to `data.js`
- `data.js` - Generated data file consumed by the map

## Build
Run the Python builder from this folder:

```bash
"C:/Program Files/WPy64-313110/python/python.exe" build_map.py
```

This reads the Excel and GeoPackage files from `../datasets` and `../kontur`, then writes `data.js`.

## Open
After building, open `index.html` in the browser.

## One-click launch
For a non-technical user, double-click `Open Telecom Map.bat`. It rebuilds `data.js` and opens the map in the default browser.

## Single-file export
If you need to send only one file, run `export_single_file_map.py`. It creates `outputs/telecom_map_europe_single_file.html`, which contains the CSS, JavaScript, and generated map data in one shareable HTML file.
