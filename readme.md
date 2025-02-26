# Every Street

Every Street is a personal driving dashboard application designed to track and visualize driving data, with a primary focus on helping the user (Davis) drive every street in a given area. The application integrates with a Bouncie device to fetch trip data, and it uses a combination of frontend and backend technologies to display, analyze, and manage this data.

**Please note:** This application is built for personal use and is not intended for wider distribution or multi-user support. It is hosted locally and is tailored to the specific needs of the developer.

## Overview

The core goal of Every Street is to track progress towards driving every street within a defined location (city, county, etc.). It leverages the Bouncie API to retrieve driving data and provides tools to visualize this data on a map, analyze driving patterns, and manage trip information.

While the primary focus is on street coverage, the application includes several additional features:

- **Live Trip Tracking:** Displays the current location of the vehicle in real-time on a map. Uses WebSockets for communication with the backend.
- **Trip Visualization:** Displays historical trips on an interactive map, allowing filtering by date range. Uses Leaflet for map display.
- **Map Matching:** Integrates with the Mapbox Map Matching API to snap raw GPS data to the road network. This helps improve the accuracy of trip routes.
- **Street Coverage Calculation:** Calculates the percentage of streets driven within a specified area, using OpenStreetMap (OSM) data. This is a core feature for the "Every Street" goal.
- **Driving Insights:** Provides charts and statistics about driving habits, including trip frequency, distance, time distribution, fuel consumption, and frequently visited locations.
- **Trip Editing:** Allows manual editing of trip data to correct errors or make adjustments.
- **Data Export:** Supports exporting trip data in GeoJSON and GPX formats.
- **Custom Places:** Enables the user to define custom areas (e.g., frequently visited locations) using a drawing tool on the map. Tracks visit statistics for these custom places.
- **Data Upload:** Allows uploading historical trip data in GPX or GeoJSON format.
- **Task Management:** Provides a user interface for viewing the status of, and managing, background tasks.

## Technology Stack

- **Frontend:**

  - HTML, CSS (with Bootstrap)
  - JavaScript
  - Leaflet (with Leaflet Draw plugin)
  - DataTables
  - Chart.js
  - Flatpickr
  - jQuery

- **Backend:**

  - Python (FastAPI)
  - MongoDB (with Motor for asynchronous access)
  - APScheduler (for background tasks)
  - aiohttp (for asynchronous HTTP requests)
  - Shapely, GeoPandas, Pyproj (for geospatial processing)

- **External APIs:**

  - Bouncie API (for vehicle data)
  - Mapbox Map Matching API
  - Nominatim (for geocoding and location validation)
  - Overpass API (for fetching OSM data)

- **Containerization:**
  - Dockerfile provided for containerization.

## Data Storage

Trip data, map matching results, OSM data, street coverage information, custom places, and task management details are stored in a MongoDB database.

## Background Tasks

The application uses APScheduler to manage several background tasks, including:

- **Fetching trips from Bouncie:** Regularly retrieves new trip data.
- **Map matching trips:** Matches trip data to the road network.
- **Calculating street coverage:** Computes the percentage of streets driven.
- **Geocoding:** Reverse geocodes trip start and end points.
- **Data cleanup:** Removes old or invalid trip data.
- **Updating geo points:** Ensures trips have start and end location data.
- **Re-geocoding trips:** Checks trips against custom places.
- **Preprocessing Streets:** Prepares street network data.

## Setup and Running

This application is designed for local use. While a Dockerfile is provided, specific instructions for setup are omitted as the project is tailored for personal use. Broadly, the steps would involve:

1.  **Environment Setup:** Install Python 3.12 and MongoDB.
2.  **Install Dependencies:** `pip install -r requirements.txt`
3.  **Environment Variables:** Create a `.env` file and set the necessary environment variables, including:
    - `MONGO_URI`: Your MongoDB connection string.
    - `CLIENT_ID`, `CLIENT_SECRET`, `REDIRECT_URI`, `AUTHORIZATION_CODE`: Your Bouncie API credentials.
    - `MAPBOX_ACCESS_TOKEN`: Your Mapbox access token.
    - `AUTHORIZED_DEVICES`: A comma-separated list of authorized Bouncie device IMEIs.
4.  **Run the Application:** `gunicorn app:app -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8080 --workers 4` (or use the Dockerfile).

## Disclaimer

This application is a personal project and comes with no guarantees. Accuracy of map matching, street coverage calculations, and other features may vary. The code is provided as-is. I eventually hope to switch to PostGIS for a database for better performance and more features, especially for street coverage calculations. It would also be nice to switch to using a more modern frontend framework like React or Vue.
