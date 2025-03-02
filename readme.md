# Every Street - A Personal Driving Dashboard

**Every Street** is a personal driving dashboard application developed by Davis to track and visualize his driving data. The primary goal is to gamify and track progress towards driving every street within a specified area (city, county, etc.). It leverages the Bouncie device and API to retrieve real-time and historical trip data, providing visualizations, analysis, and management tools tailored specifically to this unique challenge.  This is a personal project, designed for local use and single-user operation.

**Repository:** [http://github.com/realronaldrump/everystreet-new](http://github.com/realronaldrump/everystreet-new)

**Deployed Application:** [http://everystreet-new-production.up.railway.app](http://everystreet-new-production.up.railway.app)

## Table of Contents

1.  [Features](#features)
2.  [Technologies Used](#technologies-used)
3.  [Project Structure](#project-structure)
4.  [Installation and Setup](#installation-and-setup)
    *   [Prerequisites](#prerequisites)
    *   [Installation Steps](#installation-steps)
    *   [Bouncie API Setup](#bouncie-api-setup)
    *   [Running the Application (Locally)](#running-the-application-locally)
5.  [Deployment (Railway)](#deployment-railway)
6.  [Usage](#usage)
    *   [Main Map View](#main-map-view)
    *   [Trips View](#trips-view)
    *   [Edit Trips](#edit-trips)
    *   [Driving Insights](#driving-insights)
    *   [Coverage Management](#coverage-management)
    *   [Visits](#visits)
    *   [Export Data](#export-data)
    *   [Upload Data](#upload-data)
    *   [Settings](#settings)
    *   [Database Management](#database-management)
    *   [Live Trip Tracking](#live-trip-tracking)
7.  [API Endpoints](#api-endpoints)
8.  [Background Tasks](#background-tasks)

## Features

*   **Trip Data Integration:** Retrieves driving data directly from a Bouncie device via the Bouncie API.  Supports historical trip data and (with a websocket connection) near real-time updates.
*   **Map Visualization:** Displays trips on an interactive map using Leaflet.  Different layers can be toggled, including individual trips, matched trips (after map-matching), OSM boundaries, and OSM streets.  Recent trips can be highlighted.
*   **Street Coverage Calculation:** Determines the percentage of streets driven within a user-defined area.
*   **Map Matching:** Integrates with the Mapbox Map Matching API to snap GPS traces to the road network, improving data accuracy and visualization.
*   **Trip Management:** Allows viewing, deleting, and editing trip data. Includes bulk operations.
*   **Driving Insights:** Presents key driving metrics, such as total distance, average speed, fuel consumption, and trip frequency.  Includes charts for daily trips, distance, and time of day distribution.
*   **Custom Places:**  Users can define custom areas (places) on the map and track visit statistics.
*   **Data Export:**  Supports exporting trip data in GeoJSON and GPX formats.  Also supports exporting street data in GeoJSON and Shapefile formats.  Raw JSON export is also available.
*   **Data Upload:**  Supports uploading historical trip data from GPX and GeoJSON files.
*   **Database Management:**  Includes basic database management functions (optimize, clear collections).
*   **Settings:** Configuration options for background task management, including scheduling intervals and enabling/disabling tasks.
*   **Live Trip Tracking:**  Provides near real-time updates of the current vehicle location, speed, and trip statistics, via a WebSocket connection.

## Technologies Used

*   **Frontend:**
    *   HTML, CSS (with a custom "Modern UI" design system), JavaScript (mostly Vanilla JS with some jQuery)
    *   [Leaflet](https://leafletjs.com/) for interactive maps
    *   [Leaflet.draw](https://leaflet.github.io/Leaflet.draw/docs/leaflet-draw-latest/) for drawing and editing map features
    *   [Mapbox GL JS](https://docs.mapbox.com/mapbox-gl-js/guides/) (used indirectly via the Map Matching API)
    *   [Bootstrap 5](https://getbootstrap.com/) for UI components and layout
    *   [DataTables](https://datatables.net/) for interactive tables
    *   [Chart.js](https://www.chartjs.org/) for data visualization
    *   [Flatpickr](https://flatpickr.js.org/) for date and time pickers
    *   [Font Awesome](https://fontawesome.com/) for icons
*   **Backend:**
    *   [FastAPI](https://fastapi.tiangolo.com/) as the web framework
    *   [Uvicorn](https://www.uvicorn.org/) and [Gunicorn](https://gunicorn.org/) for running the application server
    *   [MongoDB](https://www.mongodb.com/) for data storage (using [Motor](https://motor.readthedocs.io/) for asynchronous access)
    *   [python-dotenv](https://pypi.org/project/python-dotenv/) for environment variable management
    *   [geojson](https://pypi.org/project/geojson/) for GeoJSON handling
    *   [gpxpy](https://pypi.org/project/gpxpy/) for GPX parsing and generation
    *   [pytz](https://pypi.org/project/pytz/) and [dateutil](https://dateutil.readthedocs.io/en/stable/) for date and time handling
    *   [Shapely](https://shapely.readthedocs.io/en/stable/manual.html) and [GeoPandas](https://geopandas.org/en/stable/) for geometric operations
    *   [rtree](https://pypi.org/project/Rtree/) for spatial indexing
    *   [APScheduler](https://apscheduler.readthedocs.io/en/stable/) for background task scheduling
*   **External APIs:**
    *   [Bouncie API](https://www.bouncie.com/developer)
    *   [Mapbox Map Matching API](https://docs.mapbox.com/api/navigation/map-matching/)
    *   [Nominatim](https://nominatim.org/) (for reverse geocoding)
    *   [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) (for fetching OSM data)

## Project Structure

```
<directory_structure>
static/
  css/
    style.css
  js/
    app.js
    coverage-management.js
    custom-places.js
    database-management.js
    driving_insights.js
    edit_trips.js
    export.js
    live_tracking.js
    loading_manager.js
    modern-ui.js
    settings.js
    sidebar.js
    trips.js
    upload.js
    utils.js
    visits.js
templates/
  base.html
  coverage_management.html
  database_management.html
  driving_insights.html
  edit_trips.html
  export.html
  index.html
  settings.html
  sidebar.html
  trips.html
  upload.html
  visits.html
.deepsource.toml
.gitignore
app.py
bouncie_trip_fetcher.py
db.py
Dockerfile
export_helpers.py
map_matching.py
preprocess_streets.py
requirements.txt
street_coverage_calculation.py
tasks.py
timestamp_utils.py
trip_processing.py
update_geo_points.py
utils.py
</directory_structure>
```

*   **`static/`**: Contains static assets like CSS, JavaScript, and images.
    *   `css/style.css`:  The main stylesheet for the application, including the Modern UI design system.
    *   `js/`:  JavaScript files for different app features.
*   **`templates/`**: Jinja2 templates for the HTML pages.
*   **`app.py`**: The main FastAPI application file. Defines API endpoints and integrates various components.
*   **`bouncie_trip_fetcher.py`**: Handles fetching trip data from the Bouncie API.
*   **`db.py`**:  Database connection and setup (MongoDB).
*   **`export_helpers.py`**: Functions to help with data export to GeoJSON and GPX.
*   **`map_matching.py`**:  Functions for interacting with the Mapbox Map Matching API.
*   **`preprocess_streets.py`**:  Fetches and preprocesses street data from OpenStreetMap using the Overpass API.
*   **`requirements.txt`**: Lists the Python dependencies.
*   **`street_coverage_calculation.py`**:  Logic for calculating street coverage statistics.
*   **`tasks.py`**: Defines background tasks using APScheduler.
*   **`timestamp_utils.py`**: Utility functions for working with timestamps and datetimes.
*   **`trip_processing.py`**: Functions for processing and validating individual trip data.
*   **`update_geo_points.py`**:  A utility script (run as a task) for populating missing start and destination GeoPoints.
*   **`utils.py`**: General utility functions, including error handling, notifications, and a custom confirmation dialog.

## Installation and Setup

### Prerequisites

*   **Python 3.9+**:  The application is built with Python 3.12, but should work with 3.9 or higher.
*   **MongoDB**:  A running MongoDB instance.  The application expects a connection string to be set in the `MONGO_URI` environment variable.  A free-tier MongoDB Atlas cluster is sufficient.
*   **Bouncie Device and API Access:**
    *   A Bouncie device installed in your vehicle.
    *   A Bouncie developer account with API access.
    *   Authorization Code obtained from the Bouncie authorization flow.  See [Bouncie API Documentation](https://www.bouncie.com/developer).
*   **Mapbox Access Token:**  Required for the Map Matching API.  Obtain a token from [Mapbox](https://www.mapbox.com/).  The token must have the `MAP_MATCHING:READ` and `MAP_MATCHING:WRITE` scopes.
*   **Node.js and npm (optional):**  If you want to modify the JavaScript and use the build system (currently unused), you will need these.
*   **Git (optional):**  For cloning the repository.

### Installation Steps

1.  **Clone the repository (or download the ZIP):**
    ```bash
    git clone http://github.com/realronaldrump/everystreet-new
    cd everystreet-new
    ```
2.  **Create a virtual environment (recommended):**
    ```bash
    python3 -m venv venv
    source venv/bin/activate  # On Linux/macOS
    venv\Scripts\activate    # On Windows
    ```
3.  **Install dependencies:**
    ```bash
    pip install -r requirements.txt
    ```
4.  **Create a `.env` file:** Create a `.env` file in the root directory of the project.  Populate it with the following environment variables:
    ```
    MONGO_URI=<your_mongodb_connection_string>
    SECRET_KEY=<a_strong_secret_key>
    CLIENT_ID=<your_bouncie_client_id>
    CLIENT_SECRET=<your_bouncie_client_secret>
    REDIRECT_URI=<your_redirect_uri>  # Usually something like 'https://localhost/callback' if testing locally
    AUTHORIZATION_CODE=<your_bouncie_authorization_code>
    MAPBOX_ACCESS_TOKEN=<your_mapbox_access_token>
    AUTHORIZED_DEVICES=<comma_separated_list_of_imei_numbers>
    ```
    Replace the placeholders (`<...>`) with your actual credentials.
5.  **Ensure MongoDB Indexes (Optional but recommended):**  The application will attempt to create necessary indexes on startup, but it is good practice to verify them.  See `db.py` for the index definitions.
6. **Initialize task history collection (Optional):** The project contains a command `init_task_history_collection()`, defined in `db.py`. If you wish to ensure that indexes are present on this collection at startup, you may call it with:
```bash
python -c "import asyncio; from db import init_task_history_collection; asyncio.run(init_task_history_collection())"
```

### Bouncie API Setup

*   Follow the Bouncie Developer documentation to obtain your `CLIENT_ID`, `CLIENT_SECRET`, and an initial `AUTHORIZATION_CODE`.
*   Set `AUTHORIZED_DEVICES` to a comma-separated list of your device IMEI numbers (without spaces).
*   Ensure you have an appropriate `REDIRECT_URI` configured in your Bouncie app settings.

### Running the Application (Locally)

You can start the application locally using Gunicorn with a Uvicorn worker.  The provided command uses 4 workers and binds to all interfaces (`0.0.0.0`) on port 8080.  You can modify these settings as needed.

```bash
gunicorn app:app -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8080 --workers 4
```

Once the server is running, you can access the application in your web browser at `http://localhost:8080`.

## Deployment (Railway)

The application is currently deployed on Railway. The following start command is used:

```bash
sh -c 'UVICORN_CMD_ARGS="--proxy-headers --forwarded-allow-ips=*" gunicorn app:app -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:${PORT:-8080} --workers 4'
```

This command does the following:
* Sets the `UVICORN_CMD_ARGS` environment variable, enabling proxy headers and allowing all forwarded IPs.
* Starts the `app:app` using gunicorn with 4 uvicorn workers, binding to port 8080, using railway's dynamic port assigning through `${PORT:-8080}`

## Usage

### Main Map View

*   The main page (`/`) displays an interactive map.
*   Initial map view is centered on a default location (if no recent trips exist) or on the last recorded trip point.
*   **Live Tracking Status:** A panel in the top right shows the connection status of the WebSocket for live trip tracking.
*   **Map Controls:** A panel at the bottom of the screen provides various controls:
    *   **Metrics:** Displays summary statistics (total trips, distance, etc.).
    *   **Layer Controls:** Allows toggling the visibility of different layers (trips, matched trips, OSM boundary, OSM streets, custom places).  Layer order can be adjusted via drag-and-drop.  Color and opacity settings are provided for most layers.
    *   **Map Display Options:** Toggles for features like highlighting recent trips.
    *   **Controls Toggle:** Minimizes/maximizes the controls panel.
*   **Clicking on a trip** on the map highlights it and shows a popup with trip details.
*   **Floating Action Button:** Provides quick access to common actions like fetching trips, map matching, and adding a custom place.

### Trips View

*   Accessible via the `/trips` route.
*   Displays a table of all trips, with columns for start time, end time, distance, start location, destination, etc.
*   Table is interactive (sortable, searchable).
*   Provides options to delete trips (individually or in bulk) and export trip data.

### Edit Trips

* Accessible via the `/edit_trips` route.
* Allows visual editing of trip data.
* Uses Leaflet.draw to place markers and adjust the trip path.
* Toggle between regular trips and matched trips.
* Save changes to update the trip geometry.

### Driving Insights

*   Accessible via the `/driving-insights` route.
*   Displays various charts and metrics:
    *   Daily trip counts (line chart).
    *   Daily distance traveled (bar chart).
    *   Trip start time distribution (radar chart).
    *   Fuel consumption (bar chart).
    *   Summary metrics (total trips, distance, fuel, max speed, idle time, most visited location).
*   Allows filtering data by date range.

### Coverage Management

*   Accessible via the `/coverage-management` route.
*   Allows defining and managing "coverage areas" (e.g., cities, counties).
*   Calculates the percentage of streets driven within each defined area.
*   Provides options to validate a location, generate OSM data (boundary and streets), update coverage, and delete areas.
*   Shows a table of coverage areas with statistics (total length, driven length, coverage percentage, last updated).
*   Uses a background task to update coverage data asynchronously.  Progress is displayed in a modal.

### Visits

*   Accessible via the `/visits` route.
*   Allows creating and managing "custom places" (user-defined polygons on the map).
*   Shows visit statistics for each custom place (total visits, last visit date).
*   Displays a map with custom places overlaid.
*   Provides a modal for managing custom places (adding, deleting).
*   Displays a table of all custom places with a link to view trips for each one
*   Displays a table of all non-custom places with aggregated visit statistics.

### Export Data

*   Accessible via the `/export` route.
*   Allows exporting trip data in GeoJSON and GPX formats.
*   Supports exporting all trips, trips within a date range, or a single trip.
*   Supports exporting street and boundary data for a validated location.

### Upload Data

*   Accessible via the `/upload` route.
*   Allows uploading historical trip data in GPX or GeoJSON format.
*   Provides a drag-and-drop zone or a file input for selection.
*   Displays a preview of uploaded files before saving.
*   Optionally performs map matching on uploaded trips.

### Settings

*   Accessible via the `/settings` route.
*   Provides controls for managing background tasks:
    *   **Global Disable:**  Enables/disables all background tasks.
    *   **Task Configuration:**  Allows adjusting the interval, enabling/disabling, and viewing the status of individual tasks.
    *   **Task History:** Shows a log of task executions, including start time, duration, status, and any errors.
*   Allows loading historical trip data from older GeoJSON files (specific to the developer's setup).
*   Provides options to update GeoPoints and refresh geocoding.
*   Allows remapping of matched trips within a specified date range or interval.

### Database Management
* Accessible via the `/database-management` route.
* Displays storage usage, including a progress bar that visually represents usage.
* Shows collection statistics (document count, size).
* Offers actions for optimizing and clearing collections (used for database maintenance).
* Provides options to optimize all collections and repair indexes.


### Live Trip Tracking

*   Uses a WebSocket connection (`/ws/live_trip`) to receive near real-time updates from the Bouncie device.
*   Displays a live tracking status panel on the map.
*   Shows the current vehicle location with a marker.
*   Draws the active trip's path as a polyline.
*   Displays trip metrics (start time, duration, distance, current speed, average speed, max speed).

## API Endpoints

The application exposes a number of REST API endpoints, primarily for data retrieval and management.  Here's a summary of the key endpoints:

*   **`/api/trips` (GET):** Retrieves trip data, optionally filtered by start/end date and IMEI.
*   **`/api/trips/{trip_id}` (GET, DELETE, PUT):** Get, delete, or update a specific trip.
*   **`/api/matched_trips` (GET):** Retrieves matched trip data.
*   **`/api/matched_trips/{trip_id}` (DELETE):** Delete a matched trip.
*   **`/api/matched_trips/remap` (POST):** Re-matches trips within a date range.
*   **`/api/map_match_trips` (POST):** Triggers map matching for trips within a date range.
*   **`/api/validate_location` (POST):** Validates a location string using the OSM Nominatim API.
*   **`/api/generate_geojson` (POST):** Generates GeoJSON data (boundary or streets) for a validated location.
*   **`/api/fetch_trips` (POST):** Fetches new trips from the Bouncie API (since last trip).
*   **`/api/fetch_trips_range` (POST):** Fetches new trips from the Bouncie API within a specific date range.
*   **`/api/metrics` (GET):** Retrieves driving metrics.
*   **`/api/driving-insights` (GET):** Retrieves data for the driving insights charts.
*   **`/api/trip-analytics` (GET):** Retrieves detailed trip analytics.
*   **`/api/last_trip_point` (GET):** Returns the coordinates of the most recent trip point.
*   **`/api/places` (GET, POST):** Retrieves or creates custom places.
*   **`/api/places/{place_id}` (DELETE):** Deletes a custom place.
*   **`/api/places/{place_id}/statistics` (GET):** Gets visit statistics for a custom place.
*   **`/api/places/{place_id}/trips` (GET):** Get trips that intersect with a given place.
*   **`/api/non_custom_places_visits` (GET):**  Gets visit data for frequently visited non-custom places.
*   **`/api/street_coverage` (POST):** Initiates street coverage calculation for a given location.
*   **`/api/street_coverage/{task_id}` (GET):** Retrieves the status/progress of a street coverage calculation task.
*   **`/api/coverage_areas` (GET):**  Retrieves all coverage areas.
*   **`/api/coverage_areas/delete` (POST):**  Deletes a coverage area.
*   **`/api/coverage_areas/cancel` (POST):**  Cancels the processing of a coverage area.
*   **`/api/preprocess_streets` (POST):** Starts the street preprocessing task for a given location.
*   **`/api/street_segment/{segment_id}` (GET):** Retrieves details for a specific street segment.
*   **`/api/export/...` (GET):** Various export endpoints (GeoJSON, GPX, etc.).
*   **`/api/upload_gpx` (POST):** Handles GPX and GeoJSON file uploads.
*   **`/api/uploaded_trips` (GET):** Retrieves uploaded trips.
*   **`/api/uploaded_trips/bulk_delete` (DELETE):**  Deletes multiple uploaded trips.
*   **`/api/background_tasks/...` (GET, POST):** Endpoints for managing background tasks (configuration, status, control).
*   **`/api/database/...` (GET, POST):** Endpoints for database management tasks.
*   **`/webhook/bouncie` (POST):** Webhook endpoint for receiving real-time data from Bouncie.
*   **`/ws/live_trip` (WebSocket):** WebSocket endpoint for live trip tracking updates.
*   **`/update_geo_points` (POST)**: Updates geo points for all documents.

## Background Tasks

The application uses APScheduler to manage background tasks.  These tasks are defined in `tasks.py`. The available tasks and their descriptions are as follows:

| Task ID                          | Display Name                   | Description                                                                                   | Default Interval (minutes) | Priority | Dependencies |
| -------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------- | -------------------------- | -------- | ------------- |
| `periodic_fetch_trips`           | Periodic Trip Fetch            | Fetches new trips from the Bouncie API.                                                      | 60                         | HIGH     |               |
| `preprocess_streets`             | Preprocess Streets            | Preprocesses street data for coverage calculations (downloads and segments OSM data).        | 1440                       | LOW      |               |
| `update_coverage_for_all_locations` | Update Coverage (All Locations) | Calculates and updates street coverage statistics for all defined coverage areas.            | 60                         | MEDIUM   | `periodic_fetch_trips` |
| `cleanup_stale_trips`            | Cleanup Stale Trips            | Archives live trips that haven't been updated recently.                                      | 60                         | LOW      |               |
| `cleanup_invalid_trips`          | Cleanup Invalid Trips          | Marks trips with invalid data as invalid.                                                    | 1440                       | LOW      |               |
| `update_geocoding`               | Update Geocoding               | Updates reverse geocoding (start/end locations) for trips that are missing this information. | 720                        | LOW      |               |
| `optimize_database`              | Optimize Database              | Performs database maintenance and optimization.                                                | 1440                       | LOW      |               |
| `remap_unmatched_trips`           | Remap Unmatched Trips            | Attempts to map-match trips that failed previously.                                           | 360                        | MEDIUM   | `periodic_fetch_trips` |
| `validate_trip_data`             | Validate Trip Data              | Checks for invalid trip data (missing fields, incorrect formats).                                | 720                        | LOW      |               |

Task scheduling is managed by `tasks.py`. The scheduler is initialized and tasks are added based on the configuration stored in the database.  The `Settings` page in the application provides an interface to manage these tasks.