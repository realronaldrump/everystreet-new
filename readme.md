# Every Street - Personal Driving Dashboard

## Overview

Every Street is a personal, locally-hosted web application designed to track and visualize your driving data. It's built specifically for individual use (by Davis, the developer) to help achieve the goal of driving every street in a given area. By integrating with a Bouncie device, Every Street automatically fetches your driving trip data, providing a comprehensive dashboard to monitor and analyze your progress.

This application is not intended for public use or multi-user environments. It's tailored for personal exploration and gamification of driving within specific locations.

## Key Features

- **Trip Tracking**: Automatically fetches and stores driving trip data from a Bouncie device.
- **Map Visualization**: Displays driven routes on an interactive map, allowing you to visualize your driving history and coverage.
- **Coverage Analysis**: Calculates and visualizes street coverage within defined areas (cities, counties, etc.), showing your progress towards driving every street.
- **Driving Insights**: Provides data analysis and metrics on your driving patterns, such as total trips, distance driven, average speed, and more.
- **Trip Management**: Tools to manage and edit trip information, including deletion and re-matching.
- **Data Export**: Options to export your driving data in various formats (GeoJSON, GPX).
- **Custom Places**: Define and manage custom places on the map for personalized tracking and analysis.
- **Modern User Interface**: Features a clean, responsive, and modern UI built with a custom design system, supporting both light and dark themes.

## Technologies Used

- **Frontend**: HTML, CSS (with a custom modern UI design system), JavaScript (including Leaflet, Chart.js, DataTables, Flatpickr).
- **Backend**: Python (FastAPI, Gunicorn, Uvicorn), MongoDB.
- **API Integration**: Bouncie API for fetching driving data, Overpass API for OpenStreetMap data.
- **Mapping**: Leaflet for interactive maps, Mapbox for map matching.

## Setup and Local Installation

To run Every Street locally, ensure you have Python and `pip` installed. Then follow these steps:

1.  **Clone the repository:**

    ```bash
    git clone http://github.com/realronaldrump/everystreet-new
    cd everystreet-new
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

    - Create a `.env` file in the project root.
    - Add your MongoDB URI, Bouncie API credentials (CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, AUTHORIZATION_CODE), and Mapbox Access Token. Example `.env` content:
      ```
      MONGO_URI=your_mongodb_connection_string
      CLIENT_ID=your_bouncie_client_id
      CLIENT_SECRET=your_bouncie_client_secret
      REDIRECT_URI=your_redirect_uri
      AUTHORIZATION_CODE=your_authorization_code
      MAPBOX_ACCESS_TOKEN=your_mapbox_access_token
      ```

5.  **Run the application using Gunicorn:**

    ```bash
    gunicorn app:app -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8080 --workers 4
    ```

    This command starts the application on `http://localhost:8080`.

## Deployment on Railway

Every Street is deployed on [Railway](http://everystreet-new-production.up.railway.app).

- **Repository:** [http://github.com/realronaldrump/everystreet-new](http://github.com/realronaldrump/everystreet-new)
- **Deployed Application:** [http://everystreet-new-production.up.railway.app](http://everystreet-new-production.up.railway.app)
- **Railway Start Command:**
  ```sh
  sh -c 'UVICORN_CMD_ARGS="--proxy-headers --forwarded-allow-ips=*" gunicorn app:app -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:${PORT:-8080} --workers 4'
  ```
  This command is set in the Railway deployment settings to ensure proper configuration for Railway's hosting environment.

## Directory Structure

```
everystreet-new/
├── static/
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── app.js
│       ├── coverage-dashboard.js
│       ├── coverage-management.js
│       ├── custom-places.js
│       ├── database-management.js
│       ├── driving_insights.js
│       ├── edit_trips.js
│       ├── export.js
│       ├── live_tracking.js
│       ├── loading_manager.js
│       ├── modern-ui.js
│       ├── settings.js
│       ├── sidebar.js
│       ├── trips.js
│       ├── upload.js
│       ├── utils.js
│       └── visits.js
├── templates/
│   ├── base.html
│   ├── coverage_dashboard.html
│   ├── coverage_management.html
│   ├── database_management.html
│   ├── driving_insights.html
│   ├── edit_trips.html
│   ├── export.html
│   ├── index.html
│   ├── settings.html
│   ├── sidebar.html
│   ├── trips.html
│   ├── upload.html
│   └── visits.html
├── .deepsource.toml
├── .gitignore
├── app.py
├── bouncie_trip_fetcher.py
├── db.py
├── Dockerfile
├── export_helpers.py
├── map_matching.py
├── preprocess_streets.py
├── requirements.txt
├── street_coverage_calculation.py
├── tasks.py
├── timestamp_utils.py
├── trip_processing.py
├── update_geo_points.py
└── utils.py
```

## File Descriptions

- **`static/css/style.css`**: Main stylesheet for the application, defining the modern UI design system and component styles.
- **`static/js/app.js`**: Core application logic, including map initialization, trip data handling, API interactions, and UI updates.
- **`static/js/coverage-dashboard.js`**: JavaScript for the coverage dashboard page, handling charts and data visualization for coverage progress.
- **`static/js/coverage-management.js`**: Script for managing coverage areas, including validation, creation, and updates of coverage data.
- **`static/js/custom-places.js`**: Manages custom places functionality, allowing users to define and interact with custom map areas.
- **`static/js/database-management.js`**: Handles database management tasks exposed in the settings page, like optimization and clearing data.
- **`static/js/driving_insights.js`**: Implements the driving insights page, generating and displaying charts and metrics on driving data.
- **`static/js/edit_trips.js`**: JavaScript for the trip editing page, enabling users to modify trip data and geometry on a map.
- **`static/js/export.js`**: Handles data export functionality, allowing users to download trip and map data in various formats.
- **`static/js/live_tracking.js`**: Implements real-time trip tracking and visualization using WebSockets.
- **`static/js/loading_manager.js`**: Manages loading states and UI overlays during asynchronous operations.
- **`static/js/modern-ui.js`**: Initializes and controls the modern UI framework components, including theme toggling and navigation.
- **`static/js/settings.js`**: Script for the settings page, managing application settings and background tasks.
- **`static/js/sidebar.js`**: Controls the sidebar navigation component and its responsive behavior.
- **`static/js/trips.js`**: JavaScript for the trips listing page, handling data display and user interactions within the trips table.
- **`static/js/upload.js`**: Manages file upload functionality for GPX and GeoJSON trip data.
- **`static/js/utils.js`**: Contains utility functions for date handling, notifications, error handling, and common UI interactions.
- **`static/js/visits.js`**: JavaScript for the visits page, managing place visits data, charts, and map interactions.
- **`templates/`**: Directory containing HTML templates for the frontend UI.
  - **`base.html`**: Base template providing the overall HTML structure and common elements for all pages.
  - **`*.html`**: Individual HTML templates for each page of the application, extending `base.html`.
- **`.deepsource.toml`**: Configuration file for DeepSource static code analysis.
- **`.gitignore`**: Specifies intentionally untracked files that Git should ignore.
- **`app.py`**: Main FastAPI application file, defining API endpoints, routing, and backend logic.
- **`bouncie_trip_fetcher.py`**: Module for fetching trip data from the Bouncie API.
- **`db.py`**: Database initialization and utility functions for MongoDB interaction.
- **`Dockerfile`**: Docker configuration for containerizing the application.
- **`export_helpers.py`**: Utility functions to assist with exporting data in different formats.
- **`map_matching.py`**: Module for performing map matching of GPS data using Mapbox API.
- **`preprocess_streets.py`**: Module for preprocessing street data from OpenStreetMap.
- **`requirements.txt`**: Lists Python dependencies for the project.
- **`street_coverage_calculation.py`**: Module for calculating street coverage statistics.
- **`tasks.py`**: Manages background tasks using APScheduler, including scheduling and execution.
- **`timestamp_utils.py`**: Utility functions for handling timestamps, especially from Bouncie API.
- **`trip_processing.py`**: Module for processing and enriching trip data, like reverse geocoding and place lookups.
- **`update_geo_points.py`**: Script to update trip documents with GeoPoint data for geospatial queries.
- **`utils.py`**: Collection of general utility functions used throughout the application.
