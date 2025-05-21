/* global L */

"use strict";

/**
 * NavigationService handles core navigation functionality including:
 * - Real-time position tracking with high accuracy
 * - Efficient street selection
 * - Turn-by-turn directions
 * - Voice guidance
 * - Route recalculation
 */
class NavigationService {
  constructor() {
    this.currentPosition = null;
    this.watchPositionId = null;
    this.targetStreet = null;
    this.currentRoute = null;
    this.isNavigating = false;
    this.onPositionUpdate = null;
    this.onNavigationUpdate = null;
    this.onRouteRecalculation = null;
    this.onNavigationError = null;
    this.onDirectionChange = null;
    this.distanceToRouteThreshold = 50; // meters
    this.routeRecalculationThreshold = 100; // meters
    this.directionsQueue = [];
    this.processingDirections = false;
    this.routeHistory = [];
    this.streetVisitStatus = new Map(); // Map<segment_id, {visited: boolean, timestamp: Date}>
    this.locationName = null;
  }

  /**
   * Start real-time position tracking with high accuracy
   */
  startTracking() {
    if (this.watchPositionId) {
      this.stopTracking();
    }

    if (!navigator.geolocation) {
      this._handleError("Geolocation is not supported by your browser");
      return false;
    }

    try {
      this.watchPositionId = navigator.geolocation.watchPosition(
        this._handlePositionUpdate.bind(this),
        this._handlePositionError.bind(this),
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 5000
        }
      );
      
      // Immediately try to get a position
      navigator.geolocation.getCurrentPosition(
        this._handlePositionUpdate.bind(this),
        this._handlePositionError.bind(this),
        { enableHighAccuracy: true, timeout: 10000 }
      );
      
      return true;
    } catch (error) {
      this._handleError(`Error starting location tracking: ${error.message}`);
      return false;
    }
  }

  /**
   * Stop tracking the user's position
   */
  stopTracking() {
    if (this.watchPositionId !== null) {
      navigator.geolocation.clearWatch(this.watchPositionId);
      this.watchPositionId = null;
      return true;
    }
    return false;
  }

  /**
   * Request a new optimized route to the nearest undriven street
   * @param {Object} locationObject - The full location object for the area
   * @param {Object} options - Additional options like target segment ID
   */
  async requestRoute(locationObject, options = {}) {
    this.locationName = locationObject.display_name; // Keep for potential internal use or logging
    
    if (!this.currentPosition) {
      this._handleError("Cannot request route: no current position available");
      return null;
    }
    
    if (!locationObject || !locationObject.display_name || !locationObject.osm_id || !locationObject.osm_type) {
      this._handleError("Cannot request route: incomplete location data provided to NavigationService.");
      console.error("Incomplete locationObject in NavigationService:", locationObject);
      return null;
    }
    
    try {
      const requestPayload = {
        location: locationObject, // Send the full location object
        current_position: {
          lat: this.currentPosition.coords.latitude,
          lon: this.currentPosition.coords.longitude
        },
        options: {
          prioritize_connectivity: true,
          avoid_highways: options.avoidHighways || false,
          max_detour: options.maxDetour || 2000, // meters
          route_type: options.routeType || "nearest"
        }
      };
      
      // If a specific segment ID is requested
      if (options.segmentId) {
        requestPayload.segment_id = options.segmentId;
      }
      
      const response = await fetch("/api/driving-navigation/next-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload)
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || `HTTP error ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data.status === "success" && data.route_geometry && data.target_street) {
        this.currentRoute = {
          geometry: data.route_geometry,
          targetStreet: data.target_street,
          duration: data.route_duration_seconds,
          distance: data.route_distance_meters,
          requestTime: new Date(),
          remainingDistance: data.route_distance_meters,
          remainingDuration: data.route_duration_seconds,
          nextManeuver: this._extractNextManeuver(data)
        };
        
        this.targetStreet = data.target_street;
        
        // Prepare for navigation if currently navigating
        if (this.isNavigating) {
          this._prepareDirections(data);
        }
        
        // Notify listeners
        if (this.onRouteRecalculation) {
          this.onRouteRecalculation(this.currentRoute);
        }
        
        return this.currentRoute;
      } else if (data.status === "completed") {
        // No more undriven streets
        this.currentRoute = null;
        this.targetStreet = null;
        
        if (this.onNavigationUpdate) {
          this.onNavigationUpdate({
            type: "completed",
            message: data.message
          });
        }
        
        return null;
      } else {
        throw new Error(data.message || "Unexpected response format");
      }
    } catch (error) {
      this._handleError(`Error requesting route: ${error.message}`);
      return null;
    }
  }

  /**
   * Extract next maneuver info from route data
   */
  _extractNextManeuver(routeData) {
    // In the future, this should parse turn-by-turn directions from the route
    // For now, return a simple "head toward target" instruction
    const streetName = routeData.target_street.street_name || "Unnamed Street";
    return {
      instruction: `Head towards ${streetName}`,
      distance: routeData.route_distance_meters,
      type: "HEAD",
      streetName
    };
  }

  /**
   * Prepare turn-by-turn directions from route data
   */
  _prepareDirections(routeData) {
    // This will be enhanced in the future to extract actual turn-by-turn directions
    // For now, use a simple approach with start and destination
    this.directionsQueue = [];
    
    const streetName = routeData.target_street.street_name || "Unnamed Street";
    
    // Add initial direction
    this.directionsQueue.push({
      instruction: `Starting navigation to ${streetName}`,
      type: "START"
    });
    
    // Add destination arrival
    this.directionsQueue.push({
      instruction: `You will arrive at ${streetName} in ${Math.round(routeData.route_duration_seconds / 60)} minutes`,
      type: "CONTINUE",
      distance: routeData.route_distance_meters
    });
    
    // Process the first direction immediately
    this._processNextDirection();
  }

  /**
   * Start navigation to the current route
   */
  startNavigation() {
    if (!this.currentRoute) {
      this._handleError("Cannot start navigation: no route available");
      return false;
    }
    
    this.isNavigating = true;
    
    // Prepare directions queue
    this._prepareDirections({
      target_street: this.targetStreet,
      route_duration_seconds: this.currentRoute.duration,
      route_distance_meters: this.currentRoute.distance
    });
    
    if (this.onNavigationUpdate) {
      this.onNavigationUpdate({
        type: "started",
        route: this.currentRoute
      });
    }
    
    return true;
  }

  /**
   * Stop active navigation
   */
  stopNavigation() {
    this.isNavigating = false;
    this.directionsQueue = [];
    
    if (this.onNavigationUpdate) {
      this.onNavigationUpdate({
        type: "stopped"
      });
    }
    
    return true;
  }

  /**
   * Mark a street segment as visited
   */
  markStreetVisited(segmentId) {
    this.streetVisitStatus.set(segmentId, {
      visited: true,
      timestamp: new Date()
    });
    
    // If we're currently navigating to this street, update status
    if (this.isNavigating && this.targetStreet && this.targetStreet.segment_id === segmentId) {
      if (this.onNavigationUpdate) {
        this.onNavigationUpdate({
          type: "arrived",
          segmentId
        });
      }
      
      // Stop navigation
      this.isNavigating = false;
    }
  }

  /**
   * Process the next direction in the queue
   */
  async _processNextDirection() {
    if (this.processingDirections || !this.isNavigating || this.directionsQueue.length === 0) {
      return;
    }
    
    this.processingDirections = true;
    
    try {
      const nextDirection = this.directionsQueue.shift();
      
      // Notify listeners
      if (this.onDirectionChange) {
        this.onDirectionChange(nextDirection);
      }
      
      // Continue processing queue
      this.processingDirections = false;
      
      // If there are more directions and we're still navigating, process the next one
      // But add a delay between directions
      if (this.directionsQueue.length > 0 && this.isNavigating) {
        setTimeout(() => this._processNextDirection(), 5000);
      }
    } catch (error) {
      this.processingDirections = false;
      this._handleError(`Error processing direction: ${error.message}`);
    }
  }

  /**
   * Handle position updates from geolocation API
   */
  _handlePositionUpdate(position) {
    this.currentPosition = position;
    
    // If we're actively navigating, check if we need to recalculate route
    if (this.isNavigating && this.currentRoute) {
      this._updateNavigationStatus();
    }
    
    // Notify listeners
    if (this.onPositionUpdate) {
      this.onPositionUpdate(position);
    }
  }
  
  /**
   * Update navigation status based on current position
   */
  _updateNavigationStatus() {
    if (!this.currentPosition || !this.currentRoute || !this.currentRoute.geometry) {
      return;
    }
    
    // Calculate distance to route
    const distanceToRoute = this._calculateDistanceToRoute();
    
    // Calculate remaining distance to target
    const distanceToTarget = this._calculateDistanceToTarget();
    
    // Update remaining info
    this.currentRoute.remainingDistance = distanceToTarget;
    this.currentRoute.remainingDuration = 
      distanceToTarget / this.currentRoute.distance * this.currentRoute.duration;
    
    // Check if we've arrived at target
    if (distanceToTarget < 30) { // Within 30 meters of target
      if (this.targetStreet) {
        this.markStreetVisited(this.targetStreet.segment_id);
      }
      return;
    }
    
    // Check if we need to recalculate route (too far from route)
    if (distanceToRoute > this.routeRecalculationThreshold) {
      // Recalculate route
      this._scheduleRouteRecalculation();
    }
    
    // Notify listeners about navigation update
    if (this.onNavigationUpdate) {
      this.onNavigationUpdate({
        type: "progress",
        remainingDistance: distanceToTarget,
        remainingDuration: this.currentRoute.remainingDuration,
        distanceToRoute: distanceToRoute
      });
    }
  }
  
  /**
   * Schedule route recalculation (with debouncing)
   */
  _scheduleRouteRecalculation() {
    if (this._recalculationTimeout) {
      clearTimeout(this._recalculationTimeout);
    }
    
    this._recalculationTimeout = setTimeout(async () => {
      if (this.isNavigating && this.locationName) {
        // Request new route to same target
        const options = {};
        if (this.targetStreet) {
          options.segmentId = this.targetStreet.segment_id;
        }
        
        await this.requestRoute(this.locationName, options);
      }
    }, 3000); // Wait 3 seconds before recalculating
  }
  
  /**
   * Calculate approximate distance to route
   */
  _calculateDistanceToRoute() {
    // Simplified implementation - in reality, we would calculate the distance
    // to the nearest point on the route line
    return 0; // Placeholder
  }
  
  /**
   * Calculate distance to target based on current position
   */
  _calculateDistanceToTarget() {
    if (!this.currentPosition || !this.targetStreet) {
      return Infinity;
    }
    
    // Get target coordinates
    const targetCoords = this.targetStreet.start_coords;
    if (!targetCoords || targetCoords.length < 2) {
      return Infinity;
    }
    
    // Calculate distance using Haversine formula
    return this._haversineDistance(
      this.currentPosition.coords.latitude, 
      this.currentPosition.coords.longitude,
      targetCoords[1], // Lat
      targetCoords[0]  // Lon
    );
  }
  
  /**
   * Calculate Haversine distance between two points
   */
  _haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    
    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    
    return R * c; // Distance in meters
  }

  /**
   * Handle position errors from geolocation API
   */
  _handlePositionError(error) {
    let errorMessage = "Unknown position error";
    
    switch (error.code) {
      case error.PERMISSION_DENIED:
        errorMessage = "Location permission denied";
        break;
      case error.POSITION_UNAVAILABLE:
        errorMessage = "Location information is unavailable";
        break;
      case error.TIMEOUT:
        errorMessage = "Location request timed out";
        break;
    }
    
    this._handleError(errorMessage);
  }

  /**
   * Handle errors and notify listeners
   */
  _handleError(message) {
    console.error(`NavigationService: ${message}`);
    
    if (this.onNavigationError) {
      this.onNavigationError({
        message
      });
    }
  }
}

// Export the class for use in other files
window.NavigationService = NavigationService; 