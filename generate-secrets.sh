#!/bin/bash

# This script generates secure random keys for JWT_SECRET_KEY and APP_SECRET
# and appends them to a .env file in the project root.

ENV_FILE=".env"

# Check if .env file exists, create if not
if [ ! -f "$ENV_FILE" ]; then
  touch "$ENV_FILE"
  echo "Created $ENV_FILE"
fi

# Generate JWT_SECRET_KEY
if ! grep -q "^JWT_SECRET_KEY=" "$ENV_FILE"; then
  JWT_SECRET_KEY=$(openssl rand -base64 32)
  echo "JWT_SECRET_KEY=$JWT_SECRET_KEY" >> "$ENV_FILE"
  echo "Generated JWT_SECRET_KEY and added to $ENV_FILE"
else
  echo "JWT_SECRET_KEY already exists in $ENV_FILE, skipping generation."
fi

# Generate APP_SECRET
if ! grep -q "^APP_SECRET=" "$ENV_FILE"; then
  APP_SECRET=$(openssl rand -base64 32)
  echo "APP_SECRET=$APP_SECRET" >> "$ENV_FILE"
  echo "Generated APP_SECRET and added to $ENV_FILE"
else
  echo "APP_SECRET already exists in $ENV_FILE, skipping generation."
fi

chmod +x generate-secrets.sh

echo "
Usage:
  ./generate-secrets.sh

Ensure you review and update other variables in your .env file as needed.
"
