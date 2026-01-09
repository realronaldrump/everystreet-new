# GitHub Copilot Instructions for EveryStreet

## Project Overview

EveryStreet is a street coverage tracking application that helps users track and visualize which streets they've driven on. The application processes GPS data, calculates street coverage, manages trips, and provides interactive map visualizations.

## Technology Stack

### Backend

- **Framework**: FastAPI (Python 3.12)
- **Database**: MongoDB with Motor (async driver)
- **Task Queue**: Celery with Redis
- **Server**: Gunicorn with Uvicorn workers
- **Key Libraries**:
  - Geographic: `geopandas`, `shapely`, `osmnx`, `networkx`, `geopy`
  - Data processing: `numpy`, `scikit_learn`
  - Validation: `pydantic`
  - HTTP: `httpx`, `aiohttp`

### Frontend

- **Languages**: JavaScript (ES6+ modules), HTML, CSS
- **Libraries**: Mapbox GL JS, Chart.js, Bootstrap, jQuery
- **Build**: No build step - native ES modules

### Development Tools

- **Python Linting**: Ruff (configured in `pyproject.toml`)
- **Python Formatting**: Ruff and Black (via DeepSource)
- **JavaScript Linting/Formatting**: Biome (configured in `biome.json`)
- **JavaScript Formatting**: Prettier (via DeepSource)
- **Import Sorting**: isort (Python, via DeepSource)
- **Type Checking**: Python type hints (not enforced by mypy)

## Code Style Guidelines

### Python

1. **Formatting**:
   - Line length: 88 characters
   - Use Ruff for linting and formatting
   - Follow PEP 8 conventions
   - Use Black-compatible formatting

2. **Type Hints**:
   - Use type hints for function signatures
   - Use `from __future__ import annotations` for forward references
   - Use `typing` module types: `dict`, `list`, `tuple`, `Any`, etc.

3. **Docstrings**:
   - Use triple-quoted strings for module, class, and function docstrings
   - Format: Start with a brief one-line summary
   - Include Args, Returns, and Raises sections for functions
   - Example:

     ```python
     """Brief description.

     Detailed description if needed.

     Args:
         param1: Description of param1
         param2: Description of param2

     Returns:
         Description of return value

     Raises:
         ExceptionType: When this exception is raised
     """
     ```

4. **Imports**:
   - Use absolute imports
   - Group imports: standard library, third-party, local
   - Use `isort` for automatic organization

5. **Naming Conventions**:
   - Functions/variables: `snake_case`
   - Classes: `PascalCase`
   - Constants: `UPPER_SNAKE_CASE`
   - Private members: prefix with `_`

### JavaScript

1. **Formatting**:
   - Use ES6+ syntax (modules, arrow functions, async/await)
   - Line length: 88 characters
   - Use double quotes for strings
   - Use semicolons
   - Trailing commas: ES5 style

2. **Modules**:
   - Use ES6 modules (`import`/`export`)
   - Organize code into modules under `static/js/modules/`
   - Export classes and functions explicitly

3. **Comments**:
   - Use JSDoc-style comments for functions and classes
   - Use `/* global */` declarations for global variables
   - Example:
     ```javascript
     /**
      * Brief description
      * More details if needed
      */
     ```

4. **Naming Conventions**:
   - Functions/variables: `camelCase`
   - Classes: `PascalCase`
   - Constants: `UPPER_SNAKE_CASE`
   - File names: `kebab-case.js`

## Project Structure

### Backend Structure

```
/
├── app.py                     # FastAPI application entry point
├── models.py                  # Pydantic models for validation
├── db.py                      # Database manager (MongoDB)
├── config.py                  # Centralized configuration
├── *_api.py                   # API routers (e.g., coverage_api.py)
├── *_service.py               # Business logic services
├── *_repository.py            # Database access layer
├── api_utils.py               # Shared API utilities
├── tasks/                     # Celery tasks
│   ├── __init__.py
│   ├── config.py
│   ├── core.py
│   └── *.py
└── coverage/                  # Modular coverage system
    └── routes/
        ├── areas.py
        ├── streets.py
        └── *.py
```

### Frontend Structure

```
static/
├── js/
│   ├── modules/              # ES6 modules
│   │   ├── coverage/
│   │   ├── map/
│   │   └── utils/
│   ├── *.js                  # Page-specific scripts
│   └── utils.js              # Shared utilities
├── css/                      # Stylesheets
└── favicon.ico
templates/                    # Jinja2 templates
```

## API Development Patterns

### FastAPI Route Definition

1. **Use APIRouter**:

   ```python
   from fastapi import APIRouter

   router = APIRouter()
   ```

2. **Apply Error Handling Decorator**:

   ```python
   from api_utils import api_route

   @router.get("/api/endpoint")
   @api_route(logger)
   async def endpoint_handler():
       # Implementation
   ```

3. **Use Pydantic Models**:
   - Define request/response models in `models.py`
   - Use for validation and documentation

4. **Database Access**:

   ```python
   from db import db_manager

   collection = db_manager.get_collection("collection_name")
   result = await collection.find_one({"_id": doc_id})
   ```

### Common Patterns

1. **Async/Await**: All database operations and HTTP requests should be async
2. **Error Handling**: Let `@api_route` decorator handle exceptions
3. **Logging**: Use module-level logger: `logger = logging.getLogger(__name__)`
4. **Response Models**: Return Pydantic models or dicts, FastAPI handles serialization

## Database Conventions

1. **Collections**: Use descriptive names (e.g., `trips`, `coverage_areas`, `streets`)
2. **Document IDs**: Use MongoDB ObjectId, convert with `ObjectId(str_id)`
3. **Timestamps**: Store as UTC datetime objects
4. **GeoJSON**: Use standard GeoJSON format for geographic data
5. **Indexes**: Define indexes for frequently queried fields

## Testing

- No formal test suite currently exists
- Manual testing is the primary validation method
- When adding tests in the future, follow pytest conventions

## Development Workflow

1. **Running Locally**:
   - Install dependencies: `pip install -r requirements.txt`
   - Set environment variables (see `.env` file)
   - Run: `uvicorn app:app --reload` or `gunicorn`

2. **Linting**:
   - Python: `ruff check .` and `ruff format .`
   - JavaScript: `npx @biomejs/biome check .`

3. **Docker**:
   - Build: `docker build -t everystreet .`
   - Run: `docker-compose up`

## Key Domain Concepts

1. **Trips**: GPS tracks representing driving routes
2. **Coverage Areas**: Geographic boundaries for tracking (cities, counties, custom)
3. **Streets**: Road network data from OpenStreetMap
4. **Street Coverage**: Which streets have been driven in a coverage area
5. **Optimal Routes**: Calculated routes to complete unvisited streets
6. **Live Tracking**: Real-time GPS tracking and street detection

## Common Tasks

### Adding a New API Endpoint

1. Create or modify an `*_api.py` file
2. Define route with `@router.get/post/put/delete()`
3. Apply `@api_route(logger)` decorator
4. Create Pydantic models if needed
5. Import and include router in `app.py`

### Adding a New Celery Task

1. Add task function to appropriate file in `tasks/`
2. Decorate with `@celery_app.task`
3. Import task in `tasks/__init__.py` if needed
4. Call task with `.delay()` or `.apply_async()`

### Working with Geographic Data

1. Use `GeometryService` for coordinate validation
2. Store GeoJSON in standard format: `{"type": "Point/LineString", "coordinates": [...]}`
3. Use `shapely` for geometric operations
4. Use `osmnx` for OpenStreetMap data retrieval

## Security Considerations

1. **Input Validation**: Always validate user input with Pydantic models
2. **MongoDB Injection**: Use parameterized queries, never string interpolation
3. **Secrets**: Store in environment variables, never commit to code
4. **CORS**: Configured in `app.py` - review before changing

## Dependencies

- Keep `requirements.txt` updated when adding Python packages
- Pin major versions but allow minor/patch updates where appropriate
- Test compatibility before updating major versions

## Additional Notes

- The application uses both sync and async MongoDB access (Motor for async)
- Celery tasks run in separate workers
- Frontend uses native ES6 modules - no bundling required
- Mapbox GL JS requires an API token (set in environment)
