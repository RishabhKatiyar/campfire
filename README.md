# Campfire Meetup Automation

Automates filling the Campfire meetup creation form via Chrome's remote debugging protocol.

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- Google Chrome installed

## Setup

**1. Install dependencies**

```bash
npm install
```

**2. Create a `.env` file** in the project root (copy from the example below):

```env
LOCATION_SEARCH=spice garden
LOCATION_RESULT_INDEX=1
GROUP=Pokémon GO K.Gate/AECS
HOSTED_BY_AMBASSADOR=true
```

| Variable | Description |
|---|---|
| `LOCATION_SEARCH` | Search term typed into the location picker |
| `LOCATION_RESULT_INDEX` | Which result to pick (0 = first, 1 = second, …) |
| `GROUP` | Exact group name as shown in the Campfire dropdown |
| `HOSTED_BY_AMBASSADOR` | `true` to check the ambassador toggle, `false` to skip |

**3. Update `events-data.json`** with the current live events from Campfire (replace the file contents when a new event season starts).

## Running

**Step 1 — Launch Chrome with remote debugging enabled**

On Windows:
```bat
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=C:\chrome-debug
```

On macOS:
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

**Step 2 — Open the Create Meetup form**

In the Chrome window that launched, navigate to [campfire.nianticlabs.com](https://campfire.nianticlabs.com), log in and be on the home page.

**Step 3 — Run the script**

```bash
node automate-v2.js
```

You will be prompted to select an event number from the list. The script fills all fields automatically and stops — **review the form, then click Continue manually**.

## What the script fills

| Field | Value |
|---|---|
| Live Event | Selected from the list |
| Title | Event name |
| Description | `Join us for <event name>!` |
| Start Date/Time | Event start − 1 hour |
| End Date/Time | Event end (unchanged) |
| Location | Result from `LOCATION_SEARCH` at index `LOCATION_RESULT_INDEX` |
| Group | `GROUP` from `.env` |
| Hosted by Ambassador | `HOSTED_BY_AMBASSADOR` from `.env` |
