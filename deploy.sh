#!/bin/bash

echo ">>> Navigating to the application directory..."
cd /home/davis/app

echo ">>> Pulling latest changes from the 'main' branch..."
git pull origin main

# Create the permanent database directory if it doesn't exist
echo ">>> Ensuring database directory exists..."
mkdir -p /home/davis/database/mongo

echo ">>> Stopping and removing old containers..."
docker-compose down

echo ">>> Building and starting new containers in the background..."
docker-compose up -d --build

echo ">>> Pruning old, unused Docker images to save space..."
docker image prune -f

echo ">>> Deployment finished successfully!"