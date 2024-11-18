from datetime import datetime
import threading
from collections import defaultdict
from flask_socketio import SocketIO

class TripTracker:
    def __init__(self, socketio):
        self.socketio = socketio
        self.active_trips = {}
        self.trip_data_buffer = defaultdict(list)
        self._lock = threading.Lock()
        
    def start_trip(self, trip_data):
        with self._lock:
            transaction_id = trip_data.get('transactionId')
            if transaction_id:
                self.active_trips[transaction_id] = {
                    'start_time': datetime.now(),
                    'coordinates': [],
                    'metrics': {},
                    'imei': trip_data.get('imei')
                }
                self.broadcast_trip_update('tripStart', trip_data)
    
    def update_trip(self, trip_data):
        with self._lock:
            transaction_id = trip_data.get('transactionId')
            if transaction_id and transaction_id in self.active_trips:
                # Buffer the GPS data points
                if 'data' in trip_data:
                    for point in trip_data['data']:
                        if 'gps' in point:
                            self.active_trips[transaction_id]['coordinates'].append(point['gps'])
                
                self.broadcast_trip_update('tripData', trip_data)
    
    def update_metrics(self, trip_data):
        with self._lock:
            transaction_id = trip_data.get('transactionId')
            if transaction_id and transaction_id in self.active_trips:
                self.active_trips[transaction_id]['metrics'] = trip_data.get('metrics', {})
                self.broadcast_trip_update('tripMetrics', trip_data)
    
    def end_trip(self, trip_data):
        with self._lock:
            transaction_id = trip_data.get('transactionId')
            if transaction_id and transaction_id in self.active_trips:
                # Add end data and clean up
                self.active_trips[transaction_id]['end_time'] = datetime.now()
                self.broadcast_trip_update('tripEnd', trip_data)
                del self.active_trips[transaction_id]
    
    def broadcast_trip_update(self, event_type, data):
        """Broadcast trip updates to all connected clients"""
        self.socketio.emit(f'trip_{event_type}', data)
    
    def get_active_trips(self):
        """Return current active trips for new client connections"""
        with self._lock:
            return {
                trip_id: {
                    'transactionId': trip_id,
                    'imei': data['imei'],
                    'start_time': data['start_time'].isoformat(),
                    'coordinates': data['coordinates'],
                    'metrics': data['metrics']
                }
                for trip_id, data in self.active_trips.items()
            }