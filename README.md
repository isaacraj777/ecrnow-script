# ecrnow-script

Simple Node.js scripts for interacting with the eCR Now workflow (key generation, API calls, FHIR operations).

## Setup

1. Clone the repo:

```bash
git clone https://github.com/isaacraj777/ecrnow-script.git
cd ecrnow-script
```

2. Install dependencies:

```bash
npm install
```

## Environment Variables

Create a `.env` file in the project root:

```bash
touch .env
```

Add your configuration values:

```dotenv
FHIR_BASE_URL=
CLIENT_ID=
CLIENT_SECRET=
ACCESS_TOKEN=
OUTPUT_DIR=./output
```

> Do not commit `.env` to Git.

## Running the Scripts

### Generate Keys & JWK

```bash
npm run keygen
```

### Run the eCR Flow

```bash
npm run run
```

This runs `scripts/ecr_flow_node.js` using your `.env` configuration.

## Notes

- The project uses ES Modules (`"type": "module"`).
- All logic lives inside the `scripts/` folder.
- To add new commands, create a script in `scripts/` and add it under `"scripts"` in `package.json`.
