# Structured Location Format Documentation

## Overview

The EveryStreet app now uses a structured format for storing location data, optimizing it for analytics while providing rich information for trip tracking and visualization.

## Structured Location Format

All location data in the application now follows this structured format:

```json
{
  "formatted_address": "1463 Spring Street, Waco, TX 76704, USA",
  "address_components": {
    "street_number": "1463",
    "street": "Spring Street",
    "city": "Waco",
    "county": "McLennan County",
    "state": "Texas",
    "postal_code": "76704",
    "country": "United States"
  },
  "coordinates": {
    "lat": 31.5456,
    "lng": -97.1234
  }
}
```

## Where It's Used

This structured format is used in the following fields in the database:

- `startLocation` - The starting point of a trip
- `destination` - The destination point of a trip

## Benefits

1. **Precise Address Components**: Easily analyze and filter trips by specific address components
2. **City and State Analysis**: Built-in indexing for efficient city and state-based queries
3. **Geographical Queries**: Includes structured coordinates for geospatial operations
4. **Consistent Format**: All location data follows the same schema
5. **Optimization for Analytics**: Fields are indexed for PowerBI and other analytics tools

## Implementation Details

The structured location format is implemented in the following parts of the application:

1. **TripProcessor**: The `geocode()` method now stores all location data in the structured format.
2. **Database**: Indexes are created for address components to optimize queries.
3. **Export Scripts**: Export scripts extract address components for CSV export.

## Database Indexes

The following indexes are created to optimize queries on location data:

- Full text search on formatted addresses
- Indexes on city and state fields for filtering and aggregation
- Geospatial indexes on coordinates for proximity searches

## Example Queries

### Find trips starting in a specific city:

```python
trips = await trips_collection.find({
    "startLocation.address_components.city": "Waco"
})
```

### Find trips ending in a specific state:

```python
trips = await trips_collection.find({
    "destination.address_components.state": "Texas"
})
```

### Find trips near a specific location:

```python
trips = await trips_collection.find({
    "startLocation.coordinates": {
        "$near": {
            "$geometry": {
                "type": "Point",
                "coordinates": [-97.1234, 31.5456]
            },
            "$maxDistance": 5000  # 5km
        }
    }
})
```

## CSV Export

When exporting trip data to CSV, the address components are extracted and included as separate columns:

- `start_address`
- `end_address`
- `start_city`
- `end_city`
- `start_state`
- `end_state`

This makes it easy to analyze trip data in PowerBI or other data analysis tools.
