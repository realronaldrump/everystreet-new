# Every Street - A Single-User Trip Tracking and Street Coverage Visualization Application

Every Street is a **personal, single-user** web application designed for tracking, visualizing, and, *most importantly*, analyzing driving data with a **core focus on calculating street coverage**.  It's built as a **monolithic application** intended for self-hosting and use by a **single developer/user** (the author).  The primary goal is to provide a tool for systematically tracking progress towards driving *every* street within a defined geographical area.  Think of it as a personal "gamification" of exploration and a way to quantify completeness in covering a road network.

The application allows the user to upload GPX and GeoJSON files, fetch trips from the Bouncie API, map-match trips to OpenStreetMap data, and then leverage this data to calculate and visualize street coverage.  It also includes features for managing custom places and gaining general driving insights, but these are secondary to the core street coverage functionality. This is not a multi-user application and is not designed for scalability beyond a single user's data.

## Features

The features are presented in order of importance and relevance to the *core* functionality of street coverage calculation:

1.  **Street Coverage Calculation and Visualization:**
    *   **Core Feature:** Calculates the percentage of streets driven within a user-defined area (city, county, state, or country).
    *   Visualizes driven and undriven streets on an interactive map using distinct colors.
    *   Provides coverage statistics: percentage of streets driven, total street length (in miles), and miles driven.
    *   Uses OpenStreetMap data (fetched via the Overpass API) to define the road network.
    *   Leverages spatial indexing (R-tree) for efficient processing.
    *   Allows for preprocessing of street data to optimize coverage calculations.
    *   Updates coverage data based on newly added trips.

2.  **Map Matching:**
    *   **Essential for Coverage:** Map-matches raw GPS trip data to the OpenStreetMap road network using the Mapbox Map Matching API. This is crucial for accurate street coverage calculation, as it aligns the GPS data with the actual streets.
    *   Supports map-matching of both newly fetched/uploaded trips and historical trips.
    *   Batch re-matching of trips based on date ranges or intervals (useful for correcting past data).
    *   Handles splitting trips into segments based on time gaps to improve matching accuracy.
    *   Filters outliers in GPS data based on speed to improve matching quality.

3.  **Trip Data Management:**
    *   **Data Source for Coverage:** Provides the underlying trip data used for coverage calculations.
    *   Fetches trips directly from the Bouncie API (requires a Bouncie device and API credentials).
    *   Supports uploading GPX and GeoJSON files containing trip data.
    *   Stores trips in a MongoDB database.
    *   Allows filtering trips by date range and IMEI (for Bouncie devices).
    *   Provides a table view of trips with options to edit, delete, and export individual trips.
    *   Supports bulk deletion of trips.
    *   Performs reverse geocoding (using Nominatim) to determine start and end locations of trips.

4.  **OSM Data Integration:**
    *   **Foundation for Coverage:** Uses OpenStreetMap data as the basis for defining the road network.
    *   Allows the user to validate and generate OSM data (boundary and streets) for a given location (city, county, state, country) using the Overpass API.
    *   Stores OSM data locally to avoid repeated API calls.

5.  **Custom Places:**
    *   Allows the user to define custom places by drawing polygons on the map.
    *   Calculates and displays visit statistics for custom places (total visits, last visit, average time spent).
    *   Shows trips associated with a specific custom place.

6.  **Driving Insights:**
    *   Provides supplementary insights into driving habits, but is *secondary* to the core street coverage feature.
    *   Calculates and displays summary metrics (total trips, total distance, total fuel consumed, max speed, total idle duration, longest trip, most visited place).
    *   Generates charts for trip counts over time, daily distance, trip time distribution, and fuel consumption.
    *   Displays detailed insights in a table.

7.  **Data Export:**
    *   Exports trip data, matched trip data, street data, and boundary data in various formats (GeoJSON, GPX, Shapefile, raw JSON).

8.  **Live Tracking:**
    *   Displays the current trip in real-time on the map using a WebSocket connection (primarily for testing and debugging).

9.  **Settings:**
    *   Provides options for managing the application, including:
        *   Loading historical trip data.
        *   Updating GeoPoints for trips.
        *   Re-geocoding all trips.
        *   Configuring and running background tasks (see below).

10. **Background Tasks:**
    *   Automates tasks such as fetching new trips, updating street coverage, and cleaning up data.
    *   Uses APScheduler for scheduling.
    *   Provides options to pause, resume, stop, enable, disable, and manually run tasks.

11. **Responsive Design & Dark Theme:**
    *   Ensures usability across different screen sizes.
    *   Provides a dark theme for better visual experience.

## Technologies Used

*   **Frontend:**
    *   HTML, CSS, JavaScript
    *   Bootstrap 5 (for styling and layout)
    *   Leaflet (for interactive maps)
    *   Leaflet.draw (for drawing polygons)
    *   Flatpickr (for date/time selection)
    *   Chart.js (for charts)
    *   DataTables (for tables)
    *   jQuery
    *   Font Awesome (for icons)

*   **Backend:**
    *   Python 3.12
    *   FastAPI (for building the web API)
    *   Motor (for asynchronous MongoDB interaction)
    *   MongoDB (for data storage)
    *   gpxpy (for GPX parsing)
    *   geojson (for GeoJSON handling)
    *   Shapely (for geometric operations)
    *   pyproj (for coordinate system transformations)
    *   rtree (for spatial indexing)
    *   APScheduler (for background task scheduling)
    *   aiohttp (for asynchronous HTTP requests)
    *   geopandas (for geospatial data manipulation)

*   **External APIs:**
    *   Bouncie API (for fetching vehicle trip data)
    *   Mapbox Map Matching API (for map-matching trips)
    *   OpenStreetMap Nominatim API (for geocoding and reverse geocoding)
    *   Overpass API (for fetching OSM data)

## Directory Structure

```text
static/
  css/
    style.css
  js/
    app.js
    custom-places.js
    driving_insights.js
    edit_trips.js
    export.js
    live_tracking.js
    loading_manager.js
    settings.js
    sidebar.js
    trips.js
    upload.js
    visits.js
templates/
  base.html
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
```

## Setup and Installation

1.  **Clone the repository:**

    ```bash
    git clone <repository_url>
    cd <repository_directory>
    ```

2.  **Create a virtual environment (recommended):**

    ```bash
    python3 -m venv venv
    source venv/bin/activate  # On Linux/macOS
    venv\Scripts\activate  # On Windows
    ```

3.  **Install dependencies:**

    ```bash
    pip install -r requirements.txt
    ```

4.  **Set up environment variables:**

    Create a `.env` file in the root directory and add the following variables (replace with your actual values):

    ```env
    MONGO_URI=<your_mongodb_connection_string>
    CLIENT_ID=<your_bouncie_client_id>
    CLIENT_SECRET=<your_bouncie_client_secret>
    REDIRECT_URI=<your_bouncie_redirect_uri>
    AUTHORIZATION_CODE=<your_bouncie_authorization_code>
    AUTHORIZED_DEVICES=<comma_separated_list_of_imeis>  # Your Bouncie device IMEI(s)
    MAPBOX_ACCESS_TOKEN=<your_mapbox_access_token>
    SECRET_KEY=<a_secret_key_for_your_app>
    ```

    **Important:**  This application is designed for a *single user* (the developer).  The `AUTHORIZED_DEVICES` variable should contain the IMEI(s) of *your* Bouncie device(s).  There is no user authentication or authorization mechanism beyond this.

5.  **Run the application:**

    ```bash
    uvicorn app:app --host 0.0.0.0 --port 8080 --reload
    ```

    The `--reload` flag enables automatic reloading of the server when code changes are detected (useful for development).  The application will be accessible at `http://localhost:8080` (or the specified port).

## Usage

The application is designed for personal use.  The primary workflow is:

1.  **Define a Location:** On the main map page, use the "OSM Data" section to enter and validate a location (city, county, state, or country). This defines the area for which street coverage will be calculated.

2.  **Generate Streets:**  Click "Generate Streets" to fetch the road network data from OpenStreetMap for the validated location. This data is stored locally.

3.  **Fetch Trips:** Use the "Fetch Trips in Range" button in the sidebar to fetch trips from the Bouncie API for your authorized device(s) within the specified date range.  Alternatively, upload GPX or GeoJSON files containing trip data.

4.  **Map Match Trips:** Click "Map Match Trips" (or "Map Match Historical Trips" for older data) to align the GPS data with the road network. This is *essential* for accurate coverage calculation.

5.  **Show Street Coverage:** Click "Show Street Coverage" to visualize the driven and undriven streets on the map. The coverage statistics will be displayed.

6.  **Explore Other Features:** Use the sidebar to navigate to other pages and explore features like custom places, driving insights, and data export.

## Background Tasks

The application uses APScheduler to schedule and run background tasks. These tasks can be configured in the "Settings" page. The following tasks are available:

*   **Fetch & Store Trips:** Fetches new trips from the Bouncie API and stores them in the database.
*   **Periodic Trip Fetch:** Fetches trips within a specified time range.
*   **Update Coverage (All Locations):** Calculates and updates street coverage data for all defined locations.  This is the most computationally intensive task.
*   **Cleanup Stale Trips:** Removes or archives stale trips from the live tracking system.
*   **Cleanup Invalid Trips:** Identifies and marks invalid trips in the database.

These tasks can be paused, resumed, stopped, enabled/disabled, and manually run from the Settings page.