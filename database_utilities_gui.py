import os
import sys
import threading
from pymongo import MongoClient
from datetime import timedelta, datetime
import certifi
from dotenv import load_dotenv
import json
from bson import json_util
import pytz
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
from tkinter.scrolledtext import ScrolledText
from dateutil import parser
from shapely.geometry import shape, LineString
import math
from timezonefinder import TimezoneFinder
import aiohttp
import asyncio
import traceback
# Load environment variables
load_dotenv()

# MongoDB setup
try:
    client = MongoClient(
        os.getenv('MONGO_URI'),
        tls=True,
        tlsAllowInvalidCertificates=True,
        tlsCAFile=certifi.where()
    )
    db = client['every_street']
    trips_collection = db['trips']
    matched_trips_collection = db['matched_trips']
    historical_trips_collection = db['historical_trips']
    uploaded_trips_collection = db['uploaded_trips']
    places_collection = db['places']
    collections = {
        'trips': trips_collection,
        'matched_trips': matched_trips_collection,
        'historical_trips': historical_trips_collection,
        'uploaded_trips': uploaded_trips_collection,
        'places': places_collection
    }
    print("Successfully connected to MongoDB")
except Exception as mongo_error:
    print(f"Error connecting to MongoDB: {mongo_error}")
    sys.exit(1)

class DatabaseUtilitiesGUI(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Database Utilities")
        self.geometry("900x700")
        self.create_widgets()

    def create_widgets(self):
        # Create tabs
        self.nb = ttk.Notebook(self)
        self.nb.pack(expand=1, fill="both")

        # Define frames for each tab
        self.stats_frame = ttk.Frame(self.nb)
        self.view_frame = ttk.Frame(self.nb)
        self.clear_frame = ttk.Frame(self.nb)
        self.delete_date_range_frame = ttk.Frame(self.nb)
        self.delete_imei_frame = ttk.Frame(self.nb)
        self.remove_duplicates_frame = ttk.Frame(self.nb)
        self.fix_missing_locations_frame = ttk.Frame(self.nb)
        self.validate_geojson_frame = ttk.Frame(self.nb)
        self.recalculate_distances_frame = ttk.Frame(self.nb)
        self.update_timezones_frame = ttk.Frame(self.nb)
        self.fix_time_frame = ttk.Frame(self.nb)
        self.undo_time_frame = ttk.Frame(self.nb)
        self.backup_frame = ttk.Frame(self.nb)
        self.restore_frame = ttk.Frame(self.nb)
        self.places_frame = ttk.Frame(self.nb)

        # Add frames as tabs
        self.nb.add(self.stats_frame, text='Collection Stats')
        self.nb.add(self.view_frame, text='View Data')
        self.nb.add(self.clear_frame, text='Clear Collection')
        self.nb.add(self.delete_date_range_frame, text='Delete by Date Range')
        self.nb.add(self.delete_imei_frame, text='Delete by IMEI')
        self.nb.add(self.remove_duplicates_frame, text='Remove Duplicates')
        self.nb.add(self.fix_missing_locations_frame, text='Fix Missing Locations')
        self.nb.add(self.validate_geojson_frame, text='Validate GeoJSON')
        self.nb.add(self.recalculate_distances_frame, text='Recalculate Distances')
        self.nb.add(self.update_timezones_frame, text='Update Timezones')
        self.nb.add(self.fix_time_frame, text='Fix Time Offsets')
        self.nb.add(self.undo_time_frame, text='Undo Time Fixes')
        self.nb.add(self.backup_frame, text='Backup Collection')
        self.nb.add(self.restore_frame, text='Restore Collection')
        self.nb.add(self.places_frame, text='Manage Places')

        # Create widgets for each tab
        self.create_stats_tab()
        self.create_view_tab()
        self.create_clear_tab()
        self.create_delete_date_range_tab()
        self.create_delete_imei_tab()
        self.create_remove_duplicates_tab()
        self.create_fix_missing_locations_tab()
        self.create_validate_geojson_tab()
        self.create_recalculate_distances_tab()
        self.create_update_timezones_tab()
        self.create_fix_time_tab()
        self.create_undo_time_tab()
        self.create_backup_tab()
        self.create_restore_tab()
        self.create_places_tab()

    def create_stats_tab(self):
        ttk.Label(self.stats_frame, text="Collection Document Counts:", font=('Helvetica', 14)).pack(pady=10)
        self.stats_text = tk.Text(self.stats_frame, height=10, width=50)
        self.stats_text.pack()
        self.refresh_stats_button = ttk.Button(self.stats_frame, text="Refresh Stats", command=self.view_collection_stats)
        self.refresh_stats_button.pack(pady=10)
        self.view_collection_stats()

    def view_collection_stats(self):
        self.stats_text.delete(1.0, tk.END)
        try:
            counts = {name: collection.count_documents({}) for name, collection in collections.items()}
            for name, count in counts.items():
                self.stats_text.insert(tk.END, f"{name}: {count} documents\n")
        except Exception as e:
            self.stats_text.insert(tk.END, f"Error: {e}")

    def create_view_tab(self):
        ttk.Label(self.view_frame, text="Select a collection to view samples:", font=('Helvetica', 14)).pack(pady=10)
        self.view_collection_var = tk.StringVar()
        self.view_collection_menu = ttk.OptionMenu(
            self.view_frame, self.view_collection_var, list(collections.keys())[0], *collections.keys())
        self.view_collection_menu.pack()
        self.view_button = ttk.Button(self.view_frame, text="View Data", command=self.view_data)
        self.view_button.pack(pady=5)
        self.view_text = ScrolledText(self.view_frame, height=20, width=90)
        self.view_text.pack()

    def view_data(self):
        collection_name = self.view_collection_var.get()
        collection = collections[collection_name]
        self.view_text.delete(1.0, tk.END)
        try:
            samples = list(collection.find().limit(5))
            if samples:
                for doc in samples:
                    self.view_text.insert(tk.END, json.dumps(doc, default=str, indent=4) + "\n\n")
            else:
                self.view_text.insert(tk.END, "No documents found in this collection.")
        except Exception as e:
            self.view_text.insert(tk.END, f"Error: {e}")

    def create_clear_tab(self):
        ttk.Label(self.clear_frame, text="Select a collection to clear:", font=('Helvetica', 14)).pack(pady=10)
        self.clear_collection_var = tk.StringVar()
        self.clear_collection_menu = ttk.OptionMenu(
            self.clear_frame, self.clear_collection_var, list(collections.keys())[0], *collections.keys())
        self.clear_collection_menu.pack()
        self.preview_clear_button = ttk.Button(self.clear_frame, text="Preview Data", command=self.preview_clear_data)
        self.preview_clear_button.pack(pady=5)
        self.clear_button = ttk.Button(self.clear_frame, text="Clear Collection", command=self.clear_collection)
        self.clear_button.pack(pady=5)
        self.clear_text = ScrolledText(self.clear_frame, height=20, width=90)
        self.clear_text.pack()

    def preview_clear_data(self):
        collection_name = self.clear_collection_var.get()
        collection = collections[collection_name]
        self.clear_text.delete(1.0, tk.END)
        try:
            samples = list(collection.find().limit(5))
            if samples:
                self.clear_text.insert(tk.END, "Sample documents to be deleted:\n\n")
                for doc in samples:
                    self.clear_text.insert(tk.END, json.dumps(doc, default=str, indent=4) + "\n\n")
            else:
                self.clear_text.insert(tk.END, "No documents found in this collection.")
        except Exception as e:
            self.clear_text.insert(tk.END, f"Error: {e}")

    def clear_collection(self):
        collection_name = self.clear_collection_var.get()
        collection = collections[collection_name]
        confirm = messagebox.askyesno("Confirm", f"Are you sure you want to clear the '{collection_name}' collection?")
        if confirm:
            threading.Thread(target=self._clear_collection_thread, args=(collection,)).start()

    def _clear_collection_thread(self, collection):
        try:
            result = collection.delete_many({})
            messagebox.showinfo("Success", f"Deleted {result.deleted_count} documents from '{collection.name}'.")
            self.view_collection_stats()
        except Exception as e:
            messagebox.showerror("Error", f"Error clearing collection: {e}")

    def create_delete_date_range_tab(self):
        ttk.Label(self.delete_date_range_frame, text="Delete Trips within Date Range", font=('Helvetica', 14)).pack(pady=10)
        ttk.Label(self.delete_date_range_frame, text="Select Collection:").pack()
        self.delete_date_collection_var = tk.StringVar()
        self.delete_date_collection_menu = ttk.OptionMenu(
            self.delete_date_range_frame, self.delete_date_collection_var, list(collections.keys())[0], *collections.keys())
        self.delete_date_collection_menu.pack()

        ttk.Label(self.delete_date_range_frame, text="Start Date (YYYY-MM-DD):").pack(pady=5)
        self.delete_start_date_entry = ttk.Entry(self.delete_date_range_frame)
        self.delete_start_date_entry.pack()

        ttk.Label(self.delete_date_range_frame, text="End Date (YYYY-MM-DD):").pack(pady=5)
        self.delete_end_date_entry = ttk.Entry(self.delete_date_range_frame)
        self.delete_end_date_entry.pack()

        self.preview_delete_date_button = ttk.Button(self.delete_date_range_frame, text="Preview Deletion", command=self.preview_delete_date_range)
        self.preview_delete_date_button.pack(pady=5)
        self.delete_date_button = ttk.Button(self.delete_date_range_frame, text="Delete", command=self.delete_date_range)
        self.delete_date_button.pack(pady=5)

        self.delete_date_text = ScrolledText(self.delete_date_range_frame, height=20, width=90)
        self.delete_date_text.pack()

    def preview_delete_date_range(self):
        collection_name = self.delete_date_collection_var.get()
        collection = collections[collection_name]
        start_date_str = self.delete_start_date_entry.get()
        end_date_str = self.delete_end_date_entry.get()

        self.delete_date_text.delete(1.0, tk.END)
        try:
            start_date = parser.isoparse(start_date_str)
            end_date = parser.isoparse(end_date_str)
        except Exception as e:
            self.delete_date_text.insert(tk.END, f"Error parsing dates: {e}")
            return

        query = {
            'startTime': {'$gte': start_date, '$lte': end_date}
        }
        samples = list(collection.find(query).limit(5))
        total_count = collection.count_documents(query)
        if samples:
            self.delete_date_text.insert(tk.END, f"Total documents to delete: {total_count}\n\nSample documents:\n\n")
            for doc in samples:
                self.delete_date_text.insert(tk.END, json.dumps(doc, default=str, indent=4) + "\n\n")
        else:
            self.delete_date_text.insert(tk.END, "No documents found in the specified date range.")

    def delete_date_range(self):
        collection_name = self.delete_date_collection_var.get()
        collection = collections[collection_name]
        start_date_str = self.delete_start_date_entry.get()
        end_date_str = self.delete_end_date_entry.get()

        try:
            start_date = parser.isoparse(start_date_str)
            end_date = parser.isoparse(end_date_str)
        except Exception as e:
            messagebox.showerror("Error", f"Error parsing dates: {e}")
            return

        confirm = messagebox.askyesno("Confirm", f"Are you sure you want to delete documents from '{collection_name}' between {start_date_str} and {end_date_str}?")
        if confirm:
            threading.Thread(target=self._delete_date_range_thread, args=(collection, start_date, end_date)).start()

    def _delete_date_range_thread(self, collection, start_date, end_date):
        try:
            query = {
                'startTime': {'$gte': start_date, '$lte': end_date}
            }
            result = collection.delete_many(query)
            messagebox.showinfo("Success", f"Deleted {result.deleted_count} documents from '{collection.name}'.")
            self.view_collection_stats()
        except Exception as e:
            messagebox.showerror("Error", f"Error deleting documents: {e}")

    def create_delete_imei_tab(self):
        ttk.Label(self.delete_imei_frame, text="Delete Trips by IMEI", font=('Helvetica', 14)).pack(pady=10)
        ttk.Label(self.delete_imei_frame, text="Select Collection:").pack()
        self.delete_imei_collection_var = tk.StringVar()
        self.delete_imei_collection_menu = ttk.OptionMenu(
            self.delete_imei_frame, self.delete_imei_collection_var, list(collections.keys())[0], *collections.keys())
        self.delete_imei_collection_menu.pack()

        ttk.Label(self.delete_imei_frame, text="Enter IMEI:").pack(pady=5)
        self.delete_imei_entry = ttk.Entry(self.delete_imei_frame)
        self.delete_imei_entry.pack()

        self.preview_delete_imei_button = ttk.Button(self.delete_imei_frame, text="Preview Deletion", command=self.preview_delete_imei)
        self.preview_delete_imei_button.pack(pady=5)
        self.delete_imei_button = ttk.Button(self.delete_imei_frame, text="Delete", command=self.delete_by_imei)
        self.delete_imei_button.pack(pady=5)

        self.delete_imei_text = ScrolledText(self.delete_imei_frame, height=20, width=90)
        self.delete_imei_text.pack()

    def preview_delete_imei(self):
        collection_name = self.delete_imei_collection_var.get()
        collection = collections[collection_name]
        imei = self.delete_imei_entry.get().strip()

        self.delete_imei_text.delete(1.0, tk.END)
        if not imei:
            self.delete_imei_text.insert(tk.END, "Please enter a valid IMEI.")
            return

        query = {
            'imei': imei
        }
        samples = list(collection.find(query).limit(5))
        total_count = collection.count_documents(query)
        if samples:
            self.delete_imei_text.insert(tk.END, f"Total documents to delete: {total_count}\n\nSample documents:\n\n")
            for doc in samples:
                self.delete_imei_text.insert(tk.END, json.dumps(doc, default=str, indent=4) + "\n\n")
        else:
            self.delete_imei_text.insert(tk.END, f"No documents found for IMEI '{imei}'.")

    def delete_by_imei(self):
        collection_name = self.delete_imei_collection_var.get()
        collection = collections[collection_name]
        imei = self.delete_imei_entry.get().strip()

        if not imei:
            messagebox.showerror("Error", "Please enter a valid IMEI.")
            return

        confirm = messagebox.askyesno("Confirm", f"Are you sure you want to delete documents from '{collection_name}' with IMEI '{imei}'?")
        if confirm:
            threading.Thread(target=self._delete_by_imei_thread, args=(collection, imei)).start()

    def _delete_by_imei_thread(self, collection, imei):
        try:
            query = {
                'imei': imei
            }
            result = collection.delete_many(query)
            messagebox.showinfo("Success", f"Deleted {result.deleted_count} documents from '{collection.name}'.")
            self.view_collection_stats()
        except Exception as e:
            messagebox.showerror("Error", f"Error deleting documents: {e}")

    def create_remove_duplicates_tab(self):
        ttk.Label(self.remove_duplicates_frame, text="Remove Duplicate Trips", font=('Helvetica', 14)).pack(pady=10)
        ttk.Label(self.remove_duplicates_frame, text="Select Collection:").pack()
        self.remove_duplicates_collection_var = tk.StringVar()
        self.remove_duplicates_collection_menu = ttk.OptionMenu(
            self.remove_duplicates_frame, self.remove_duplicates_collection_var, list(collections.keys())[0], *collections.keys())
        self.remove_duplicates_collection_menu.pack()

        self.preview_remove_duplicates_button = ttk.Button(self.remove_duplicates_frame, text="Preview Duplicates", command=self.preview_remove_duplicates)
        self.preview_remove_duplicates_button.pack(pady=5)
        self.remove_duplicates_button = ttk.Button(self.remove_duplicates_frame, text="Remove Duplicates", command=self.remove_duplicates)
        self.remove_duplicates_button.pack(pady=5)

        self.remove_duplicates_text = ScrolledText(self.remove_duplicates_frame, height=20, width=90)
        self.remove_duplicates_text.pack()

    def preview_remove_duplicates(self):
        collection_name = self.remove_duplicates_collection_var.get()
        collection = collections[collection_name]

        self.remove_duplicates_text.delete(1.0, tk.END)
        pipeline = [
            {"$group": {"_id": "$transactionId", "count": {"$sum": 1}, "ids": {"$push": "$_id"}}},
            {"$match": {"count": {"$gt": 1}}}
        ]
        duplicates = list(collection.aggregate(pipeline))
        total_duplicates = len(duplicates)
        if duplicates:
            self.remove_duplicates_text.insert(tk.END, f"Total duplicate transactionIds: {total_duplicates}\n\nSample duplicates:\n\n")
            for dup in duplicates[:5]:
                self.remove_duplicates_text.insert(tk.END, f"transactionId: {dup['_id']}, Count: {dup['count']}\n")
        else:
            self.remove_duplicates_text.insert(tk.END, "No duplicates found.")

    def remove_duplicates(self):
        collection_name = self.remove_duplicates_collection_var.get()
        collection = collections[collection_name]

        confirm = messagebox.askyesno("Confirm", f"Are you sure you want to remove duplicates from '{collection_name}'?")
        if confirm:
            threading.Thread(target=self._remove_duplicates_thread, args=(collection,)).start()

    def _remove_duplicates_thread(self, collection):
        try:
            pipeline = [
                {"$group": {"_id": "$transactionId", "count": {"$sum": 1}, "ids": {"$push": "$_id"}}},
                {"$match": {"count": {"$gt": 1}}}
            ]
            duplicates = list(collection.aggregate(pipeline))
            total_removed = 0
            for dup in duplicates:
                ids_to_remove = dup['ids'][1:]  # Keep one document
                result = collection.delete_many({'_id': {'$in': ids_to_remove}})
                total_removed += result.deleted_count
            messagebox.showinfo("Success", f"Removed {total_removed} duplicate documents from '{collection.name}'.")
            self.view_collection_stats()
        except Exception as e:
            messagebox.showerror("Error", f"Error removing duplicates: {e}")

    def create_fix_missing_locations_tab(self):
        ttk.Label(self.fix_missing_locations_frame, text="Fix Missing Locations", font=('Helvetica', 14)).pack(pady=10)
        ttk.Label(self.fix_missing_locations_frame, text="Select Collection:").pack()
        self.fix_missing_locations_collection_var = tk.StringVar()
        self.fix_missing_locations_collection_menu = ttk.OptionMenu(
            self.fix_missing_locations_frame, self.fix_missing_locations_collection_var, list(collections.keys())[0], *collections.keys())
        self.fix_missing_locations_collection_menu.pack()

        self.preview_fix_missing_locations_button = ttk.Button(self.fix_missing_locations_frame, text="Preview Missing Locations", command=self.preview_fix_missing_locations)
        self.preview_fix_missing_locations_button.pack(pady=5)
        self.fix_missing_locations_button = ttk.Button(self.fix_missing_locations_frame, text="Fix Missing Locations", command=self.fix_missing_locations)
        self.fix_missing_locations_button.pack(pady=5)

        self.fix_missing_locations_text = ScrolledText(self.fix_missing_locations_frame, height=20, width=90)
        self.fix_missing_locations_text.pack()

    async def reverse_geocode_nominatim(self, lat, lon):
        """Get location name from coordinates using Nominatim"""
        try:
            # Add delay to respect Nominatim's usage policy
            await asyncio.sleep(1)
            
            url = f"https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat={lat}&lon={lon}"
            headers = {'User-Agent': 'EveryStreet/1.0'}
            
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        return data.get('display_name', '')
                    return ''
        except Exception as e:
            print(f"Error in reverse geocoding: {e}")
            return ''

    def preview_fix_missing_locations(self):
        collection_name = self.fix_missing_locations_collection_var.get()
        collection = collections[collection_name]

        self.fix_missing_locations_text.delete(1.0, tk.END)
        query = {
            '$or': [
                {'startLocation': {'$exists': False}}, 
                {'destination': {'$exists': False}},
                {'startLocation': None},
                {'destination': None},
                {'startLocation': ''},
                {'destination': ''}
            ]
        }
        samples = list(collection.find(query).limit(5))
        total_count = collection.count_documents(query)
        if samples:
            self.fix_missing_locations_text.insert(tk.END, f"Total documents with missing locations: {total_count}\n\nSample documents:\n\n")
            for doc in samples:
                self.fix_missing_locations_text.insert(tk.END, json.dumps(doc, default=str, indent=4) + "\n\n")
        else:
            self.fix_missing_locations_text.insert(tk.END, "No documents with missing locations found.")

    def fix_missing_locations(self):
        collection_name = self.fix_missing_locations_collection_var.get()
        collection = collections[collection_name]

        confirm = messagebox.askyesno("Confirm", f"Are you sure you want to fix missing locations in '{collection_name}'?")
        if confirm:
            threading.Thread(target=self._fix_missing_locations_thread, args=(collection,)).start()

    def _fix_missing_locations_thread(self, collection):
        try:
            query = {
                '$or': [
                    {'startLocation': {'$exists': False}}, 
                    {'destination': {'$exists': False}},
                    {'startLocation': None},
                    {'destination': None},
                    {'startLocation': ''},
                    {'destination': ''}
                ]
            }
            cursor = collection.find(query)
            updated_count = 0

            for doc in cursor:
                try:
                    # Handle GPS data which might be a string or dict
                    gps_data = doc.get('gps')
                    if not gps_data:
                        continue

                    # Parse GPS data if it's a string
                    if isinstance(gps_data, str):
                        try:
                            gps_data = json.loads(gps_data)
                        except json.JSONDecodeError:
                            continue

                    # Extract coordinates
                    coordinates = gps_data.get('coordinates', [])
                    if not coordinates or len(coordinates) < 2:
                        continue

                    # Get start and end points
                    start_point = coordinates[0]  # [lon, lat]
                    end_point = coordinates[-1]   # [lon, lat]

                    # Create async event loop
                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)

                    # Get location names
                    start_location = loop.run_until_complete(
                        self.reverse_geocode_nominatim(start_point[1], start_point[0]))
                    destination = loop.run_until_complete(
                        self.reverse_geocode_nominatim(end_point[1], end_point[0]))
                    
                    loop.close()

                    # Update document with new locations
                    if start_location or destination:
                        update_dict = {}
                        if start_location:
                            update_dict['startLocation'] = start_location
                        if destination:
                            update_dict['destination'] = destination

                        collection.update_one(
                            {'_id': doc['_id']},
                            {'$set': update_dict}
                        )
                        updated_count += 1

                        # Update preview text
                        self.fix_missing_locations_text.insert(tk.END, 
                            f"Updated document {doc.get('transactionId', 'Unknown')}:\n"
                            f"Start: {start_location}\n"
                            f"End: {destination}\n\n")

                except Exception as doc_error:
                    print(f"Error processing document {doc.get('transactionId', 'Unknown')}: {doc_error}")
                    continue

            messagebox.showinfo("Success", f"Fixed missing locations for {updated_count} documents in '{collection.name}'.")
            
        except Exception as e:
            error_msg = f"Error fixing locations: {str(e)}\n{traceback.format_exc()}"
            print(error_msg)
            messagebox.showerror("Error", error_msg)

    def create_validate_geojson_tab(self):
        ttk.Label(self.validate_geojson_frame, text="Validate and Fix GeoJSON Data", font=('Helvetica', 14)).pack(pady=10)
        ttk.Label(self.validate_geojson_frame, text="Select Collection:").pack()
        self.validate_geojson_collection_var = tk.StringVar()
        self.validate_geojson_collection_menu = ttk.OptionMenu(
            self.validate_geojson_frame, self.validate_geojson_collection_var, list(collections.keys())[0], *collections.keys())
        self.validate_geojson_collection_menu.pack()

        self.preview_validate_geojson_button = ttk.Button(self.validate_geojson_frame, text="Preview Invalid GeoJSON", command=self.preview_validate_geojson)
        self.preview_validate_geojson_button.pack(pady=5)
        self.validate_geojson_button = ttk.Button(self.validate_geojson_frame, text="Validate and Fix GeoJSON", command=self.validate_geojson)
        self.validate_geojson_button.pack(pady=5)

        self.validate_geojson_text = ScrolledText(self.validate_geojson_frame, height=20, width=90)
        self.validate_geojson_text.pack()

    def preview_validate_geojson(self):
        collection_name = self.validate_geojson_collection_var.get()
        collection = collections[collection_name]

        self.validate_geojson_text.delete(1.0, tk.END)
        samples = []
        cursor = collection.find().limit(100)
        for doc in cursor:
            gps_data = doc['gps']
            if isinstance(gps_data, str):
                gps_data = json.loads(gps_data)
            try:
                shape(gps_data)
            except Exception:
                samples.append(doc)
                if len(samples) >=5:
                    break
        total_invalid = len(samples)
        if samples:
            self.validate_geojson_text.insert(tk.END, f"Sample invalid GeoJSON documents:\n\n")
            for doc in samples:
                self.validate_geojson_text.insert(tk.END, json.dumps(doc, default=str, indent=4) + "\n\n")
        else:
            self.validate_geojson_text.insert(tk.END, "No invalid GeoJSON found in sample.")

    def validate_geojson(self):
        collection_name = self.validate_geojson_collection_var.get()
        collection = collections[collection_name]

        confirm = messagebox.askyesno("Confirm", f"Are you sure you want to validate and fix GeoJSON in '{collection_name}'?")
        if confirm:
            threading.Thread(target=self._validate_geojson_thread, args=(collection,)).start()

    def _validate_geojson_thread(self, collection):
        try:
            cursor = collection.find()
            fixed_count = 0
            for doc in cursor:
                gps_data = doc['gps']
                if isinstance(gps_data, str):
                    gps_data = json.loads(gps_data)
                try:
                    shape(gps_data)
                except Exception:
                    # Attempt to fix or remove invalid gps data
                    # For simplicity, we'll remove the gps field
                    collection.update_one(
                        {'_id': doc['_id']},
                        {'$unset': {'gps': ""}}
                    )
                    fixed_count += 1
            messagebox.showinfo("Success", f"Validated GeoJSON for '{collection.name}', fixed {fixed_count} documents.")
        except Exception as e:
            messagebox.showerror("Error", f"Error validating GeoJSON: {e}")

    def create_recalculate_distances_tab(self):
        ttk.Label(self.recalculate_distances_frame, text="Recalculate Distances", font=('Helvetica', 14)).pack(pady=10)
        ttk.Label(self.recalculate_distances_frame, text="Select Collection:").pack()
        self.recalculate_distances_collection_var = tk.StringVar()
        self.recalculate_distances_collection_menu = ttk.OptionMenu(
            self.recalculate_distances_frame, self.recalculate_distances_collection_var, list(collections.keys())[0], *collections.keys())
        self.recalculate_distances_collection_menu.pack()

        self.preview_recalculate_distances_button = ttk.Button(self.recalculate_distances_frame, text="Preview Recalculations", command=self.preview_recalculate_distances)
        self.preview_recalculate_distances_button.pack(pady=5)
        self.recalculate_distances_button = ttk.Button(self.recalculate_distances_frame, text="Recalculate Distances", command=self.recalculate_distances)
        self.recalculate_distances_button.pack(pady=5)

        self.recalculate_distances_text = ScrolledText(self.recalculate_distances_frame, height=20, width=90)
        self.recalculate_distances_text.pack()

    def preview_recalculate_distances(self):
        collection_name = self.recalculate_distances_collection_var.get()
        collection = collections[collection_name]

        self.recalculate_distances_text.delete(1.0, tk.END)
        try:
            samples = list(collection.find().limit(5))
            if samples:
                self.recalculate_distances_text.insert(tk.END, "Sample recalculations:\n\n")
                for doc in samples:
                    gps_data = doc['gps']
                    if isinstance(gps_data, str):
                        gps_data = json.loads(gps_data)
                    distance = self.calculate_distance(gps_data['coordinates'])
                    self.recalculate_distances_text.insert(tk.END, f"Original distance: {doc.get('distance', 'N/A')}, Recalculated: {round(distance, 2)} miles\n\n")
            else:
                self.recalculate_distances_text.insert(tk.END, "No documents found.")
        except Exception as e:
            self.recalculate_distances_text.insert(tk.END, f"Error: {e}")

    def recalculate_distances(self):
        collection_name = self.recalculate_distances_collection_var.get()
        collection = collections[collection_name]

        confirm = messagebox.askyesno("Confirm", f"Are you sure you want to recalculate distances in '{collection_name}'?")
        if confirm:
            threading.Thread(target=self._recalculate_distances_thread, args=(collection,)).start()

    def _recalculate_distances_thread(self, collection):
        try:
            cursor = collection.find()
            updated_count = 0
            for doc in cursor:
                gps_data = doc.get('gps')
                if not gps_data:
                    continue
                if isinstance(gps_data, str):
                    gps_data = json.loads(gps_data)
                coordinates = gps_data.get('coordinates')
                if not coordinates:
                    continue
                distance = self.calculate_distance(coordinates)
                collection.update_one(
                    {"_id": doc["_id"]},
                    {"$set": {
                        "distance": round(distance, 2)
                    }}
                )
                updated_count += 1
            messagebox.showinfo("Success", f"Recalculated distances for {updated_count} documents in '{collection.name}'.")
        except Exception as e:
            messagebox.showerror("Error", f"Error recalculating distances: {e}")

    def calculate_distance(self, coordinates):
        total_distance = 0.0
        for i in range(len(coordinates) - 1):
            lon1, lat1 = coordinates[i]
            lon2, lat2 = coordinates[i + 1]
            total_distance += self.haversine_distance(lon1, lat1, lon2, lat2)
        return total_distance

    def haversine_distance(self, lon1, lat1, lon2, lat2):
        R = 3958.8  # Earth radius in miles
        phi1 = math.radians(lat1)
        phi2 = math.radians(lat2)
        d_phi = math.radians(lat2 - lat1)
        d_lambda = math.radians(lon2 - lon1)
        a = math.sin(d_phi/2.0)**2 + \
            math.cos(phi1)*math.cos(phi2)*math.sin(d_lambda/2.0)**2
        c = 2*math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return R * c

    def create_update_timezones_tab(self):
        ttk.Label(self.update_timezones_frame, text="Update Timezones", font=('Helvetica', 14)).pack(pady=10)
        ttk.Label(self.update_timezones_frame, text="Select Collection:").pack()
        self.update_timezones_collection_var = tk.StringVar()
        self.update_timezones_collection_menu = ttk.OptionMenu(
            self.update_timezones_frame, self.update_timezones_collection_var, list(collections.keys())[0], *collections.keys())
        self.update_timezones_collection_menu.pack()

        self.preview_update_timezones_button = ttk.Button(self.update_timezones_frame, text="Preview Timezones", command=self.preview_update_timezones)
        self.preview_update_timezones_button.pack(pady=5)
        self.update_timezones_button = ttk.Button(self.update_timezones_frame, text="Update Timezones", command=self.update_timezones)
        self.update_timezones_button.pack(pady=5)

        self.update_timezones_text = ScrolledText(self.update_timezones_frame, height=20, width=90)
        self.update_timezones_text.pack()

    def preview_update_timezones(self):
        collection_name = self.update_timezones_collection_var.get()
        collection = collections[collection_name]

        self.update_timezones_text.delete(1.0, tk.END)
        try:
            tf = TimezoneFinder()
            samples = list(collection.find().limit(5))
            if samples:
                self.update_timezones_text.insert(tk.END, "Sample timezone updates:\n\n")
                for doc in samples:
                    gps_data = doc.get('gps')
                    if not gps_data:
                        continue
                    if isinstance(gps_data, str):
                        gps_data = json.loads(gps_data)
                    coords = gps_data.get('coordinates')
                    if not coords:
                        continue
                    midpoint = coords[len(coords)//2]
                    timezone = tf.timezone_at(lng=midpoint[0], lat=midpoint[1])
                    original_timezone = doc.get('timezone', 'N/A')
                    self.update_timezones_text.insert(tk.END, f"Original timezone: {original_timezone}, New timezone: {timezone}\n\n")
            else:
                self.update_timezones_text.insert(tk.END, "No documents found.")
        except Exception as e:
            self.update_timezones_text.insert(tk.END, f"Error: {e}")

    def update_timezones(self):
        collection_name = self.update_timezones_collection_var.get()
        collection = collections[collection_name]

        confirm = messagebox.askyesno("Confirm", f"Are you sure you want to update timezones in '{collection_name}'?")
        if confirm:
            threading.Thread(target=self._update_timezones_thread, args=(collection,)).start()

    def _update_timezones_thread(self, collection):
        try:
            tf = TimezoneFinder()
            cursor = collection.find()
            updated_count = 0
            for doc in cursor:
                gps_data = doc.get('gps')
                if not gps_data:
                    continue
                if isinstance(gps_data, str):
                    gps_data = json.loads(gps_data)
                coords = gps_data.get('coordinates')
                if not coords:
                    continue
                midpoint = coords[len(coords)//2]
                timezone = tf.timezone_at(lng=midpoint[0], lat=midpoint[1])
                if timezone:
                    collection.update_one(
                        {"_id": doc["_id"]},
                        {"$set": {
                            "timezone": timezone
                        }}
                    )
                    updated_count += 1
            messagebox.showinfo("Success", f"Updated timezones for {updated_count} documents in '{collection.name}'.")
        except Exception as e:
            messagebox.showerror("Error", f"Error updating timezones: {e}")

    def create_fix_time_tab(self):
        ttk.Label(self.fix_time_frame, text="Fix Time Offsets", font=('Helvetica', 14)).pack(pady=10)
        ttk.Label(self.fix_time_frame, text="Select Collection:").pack()
        self.fix_time_collection_var = tk.StringVar()
        self.fix_time_collection_menu = ttk.OptionMenu(
            self.fix_time_frame, self.fix_time_collection_var, 'trips', 'matched_trips')  # Only allow collections with time fields
        self.fix_time_collection_menu.pack()
        ttk.Label(self.fix_time_frame, text="Hours to Adjust (+/-):").pack(pady=5)
        self.fix_time_offset_entry = ttk.Entry(self.fix_time_frame)
        self.fix_time_offset_entry.pack()
        self.preview_fix_time_button = ttk.Button(self.fix_time_frame, text="Preview Changes", command=self.preview_fix_time_offsets)
        self.preview_fix_time_button.pack(pady=5)
        self.fix_time_button = ttk.Button(self.fix_time_frame, text="Apply Time Fix", command=self.fix_time_offsets)
        self.fix_time_button.pack(pady=5)
        self.fix_time_text = ScrolledText(self.fix_time_frame, height=20, width=90)
        self.fix_time_text.pack()

    def preview_fix_time_offsets(self):
        collection_name = self.fix_time_collection_var.get()
        collection = collections[collection_name]
        offset_str = self.fix_time_offset_entry.get().strip()

        self.fix_time_text.delete(1.0, tk.END)
        try:
            hours_offset = float(offset_str)
        except ValueError:
            self.fix_time_text.insert(tk.END, "Please enter a valid number for hours offset.")
            return

        samples = list(collection.find().limit(5))
        if samples:
            self.fix_time_text.insert(tk.END, "Sample time adjustments:\n\n")
            for doc in samples:
                original_start = doc['startTime']
                original_end = doc['endTime']
                corrected_start_time = original_start + timedelta(hours=hours_offset)
                corrected_end_time = original_end + timedelta(hours=hours_offset)
                self.fix_time_text.insert(tk.END, f"Original Start: {original_start}, Adjusted Start: {corrected_start_time}\n")
                self.fix_time_text.insert(tk.END, f"Original End: {original_end}, Adjusted End: {corrected_end_time}\n\n")
        else:
            self.fix_time_text.insert(tk.END, "No documents found in this collection.")

    def fix_time_offsets(self):
        collection_name = self.fix_time_collection_var.get()
        collection = collections[collection_name]
        offset_str = self.fix_time_offset_entry.get().strip()

        try:
            hours_offset = float(offset_str)
        except ValueError:
            messagebox.showerror("Error", "Please enter a valid number for hours offset.")
            return
        confirm = messagebox.askyesno("Confirm", f"Are you sure you want to adjust times by {hours_offset} hours in '{collection_name}'?")
        if confirm:
            threading.Thread(target=self._fix_time_offsets_thread, args=(collection, hours_offset)).start()

    def _fix_time_offsets_thread(self, collection, hours_offset):
        try:
            trips = collection.find()
            updated_count = 0
            for trip in trips:
                corrected_start_time = trip['startTime'] + timedelta(hours=hours_offset)
                corrected_end_time = trip['endTime'] + timedelta(hours=hours_offset)
                collection.update_one(
                    {"_id": trip["_id"]},
                    {"$set": {
                        "startTime": corrected_start_time,
                        "endTime": corrected_end_time
                    }}
                )
                updated_count += 1
            messagebox.showinfo("Success", f"Updated {updated_count} documents in '{collection.name}'.")
        except Exception as e:
            messagebox.showerror("Error", f"Error fixing time offsets: {e}")

    def create_undo_time_tab(self):
        ttk.Label(self.undo_time_frame, text="Undo Time Fixes", font=('Helvetica', 14)).pack(pady=10)
        ttk.Label(self.undo_time_frame, text="Select Collection:").pack()
        self.undo_time_collection_var = tk.StringVar()
        self.undo_time_collection_menu = ttk.OptionMenu(
            self.undo_time_frame, self.undo_time_collection_var, 'trips', 'matched_trips')  # Only allow collections with time fields
        self.undo_time_collection_menu.pack()
        ttk.Label(self.undo_time_frame, text="Hours to Undo (+/-):").pack(pady=5)
        self.undo_time_offset_entry = ttk.Entry(self.undo_time_frame)
        self.undo_time_offset_entry.pack()
        self.preview_undo_time_button = ttk.Button(self.undo_time_frame, text="Preview Changes", command=self.preview_undo_time_offsets)
        self.preview_undo_time_button.pack(pady=5)
        self.undo_time_button = ttk.Button(self.undo_time_frame, text="Undo Time Fix", command=self.undo_time_offsets)
        self.undo_time_button.pack(pady=5)
        self.undo_time_text = ScrolledText(self.undo_time_frame, height=20, width=90)
        self.undo_time_text.pack()

    def preview_undo_time_offsets(self):
        collection_name = self.undo_time_collection_var.get()
        collection = collections[collection_name]
        offset_str = self.undo_time_offset_entry.get().strip()

        self.undo_time_text.delete(1.0, tk.END)
        try:
            hours_offset = float(offset_str)
        except ValueError:
            self.undo_time_text.insert(tk.END, "Please enter a valid number for hours offset.")
            return

        samples = list(collection.find().limit(5))
        if samples:
            self.undo_time_text.insert(tk.END, "Sample time adjustments:\n\n")
            for doc in samples:
                original_start = doc['startTime']
                original_end = doc['endTime']
                corrected_start_time = original_start - timedelta(hours=hours_offset)
                corrected_end_time = original_end - timedelta(hours=hours_offset)
                self.undo_time_text.insert(tk.END, f"Original Start: {original_start}, Adjusted Start: {corrected_start_time}\n")
                self.undo_time_text.insert(tk.END, f"Original End: {original_end}, Adjusted End: {corrected_end_time}\n\n")
        else:
            self.undo_time_text.insert(tk.END, "No documents found in this collection.")

    def undo_time_offsets(self):
        collection_name = self.undo_time_collection_var.get()
        collection = collections[collection_name]
        offset_str = self.undo_time_offset_entry.get().strip()

        try:
            hours_offset = float(offset_str)
        except ValueError:
            messagebox.showerror("Error", "Please enter a valid number for hours offset.")
            return
        confirm = messagebox.askyesno("Confirm", f"Are you sure you want to undo time adjustment by {hours_offset} hours in '{collection_name}'?")
        if confirm:
            threading.Thread(target=self._undo_time_offsets_thread, args=(collection, hours_offset)).start()

    def _undo_time_offsets_thread(self, collection, hours_offset):
        try:
            trips = collection.find()
            updated_count = 0
            for trip in trips:
                corrected_start_time = trip['startTime'] - timedelta(hours=hours_offset)
                corrected_end_time = trip['endTime'] - timedelta(hours=hours_offset)
                collection.update_one(
                    {"_id": trip["_id"]},
                    {"$set": {
                        "startTime": corrected_start_time,
                        "endTime": corrected_end_time
                    }}
                )
                updated_count += 1
            messagebox.showinfo("Success", f"Updated {updated_count} documents in '{collection.name}'.")
        except Exception as e:
            messagebox.showerror("Error", f"Error undoing time offsets: {e}")

    def create_backup_tab(self):
        ttk.Label(self.backup_frame, text="Select a collection to backup:", font=('Helvetica', 14)).pack(pady=10)
        self.backup_collection_var = tk.StringVar()
        self.backup_collection_menu = ttk.OptionMenu(
            self.backup_frame, self.backup_collection_var, list(collections.keys())[0], *collections.keys())
        self.backup_collection_menu.pack()
        self.preview_backup_button = ttk.Button(self.backup_frame, text="Preview Backup Data", command=self.preview_backup)
        self.preview_backup_button.pack(pady=5)
        self.backup_button = ttk.Button(self.backup_frame, text="Backup Collection", command=self.backup_collection)
        self.backup_button.pack(pady=5)
        self.backup_text = ScrolledText(self.backup_frame, height=20, width=90)
        self.backup_text.pack()

    def preview_backup(self):
        collection_name = self.backup_collection_var.get()
        collection = collections[collection_name]
        self.backup_text.delete(1.0, tk.END)
        try:
            samples = list(collection.find().limit(5))
            if samples:
                self.backup_text.insert(tk.END, f"Sample data from '{collection_name}':\n\n")
                for doc in samples:
                    self.backup_text.insert(tk.END, json.dumps(doc, default=str, indent=4) + "\n\n")
            else:
                self.backup_text.insert(tk.END, "No documents found in this collection.")
        except Exception as e:
            self.backup_text.insert(tk.END, f"Error: {e}")

    def backup_collection(self):
        collection_name = self.backup_collection_var.get()
        collection = collections[collection_name]
        save_path = filedialog.asksaveasfilename(defaultextension=".json", initialfile=f"{collection_name}_backup.json")
        if save_path:
            threading.Thread(target=self._backup_collection_thread, args=(collection, save_path)).start()

    def _backup_collection_thread(self, collection, save_path):
        try:
            documents = list(collection.find())
            if not documents:
                messagebox.showinfo("Info", f"No documents found in the '{collection.name}' collection.")
                return
            with open(save_path, 'w') as backup_file:
                json.dump(documents, backup_file, default=json_util.default)
            messagebox.showinfo("Success", f"Backup of '{collection.name}' saved to '{save_path}'.")
        except Exception as e:
            messagebox.showerror("Error", f"Error backing up collection: {e}")

    def create_restore_tab(self):
        ttk.Label(self.restore_frame, text="Select a collection to restore:", font=('Helvetica', 14)).pack(pady=10)
        self.restore_collection_var = tk.StringVar()
        self.restore_collection_menu = ttk.OptionMenu(
            self.restore_frame, self.restore_collection_var, list(collections.keys())[0], *collections.keys())
        self.restore_collection_menu.pack()
        self.load_backup_button = ttk.Button(self.restore_frame, text="Load Backup File", command=self.load_backup_file)
        self.load_backup_button.pack(pady=5)
        self.preview_restore_button = ttk.Button(self.restore_frame, text="Preview Restore Data", command=self.preview_restore)
        self.preview_restore_button.pack(pady=5)
        self.restore_button = ttk.Button(self.restore_frame, text="Restore Collection", command=self.restore_collection)
        self.restore_button.pack(pady=5)
        self.restore_text = ScrolledText(self.restore_frame, height=20, width=90)
        self.restore_text.pack()
        self.backup_data = None

    def load_backup_file(self):
        file_path = filedialog.askopenfilename(filetypes=[("JSON Files", "*.json")])
        if file_path:
            try:
                with open(file_path, 'r') as backup_file:
                    self.backup_data = json.load(backup_file, object_hook=json_util.object_hook)
                self.restore_text.delete(1.0, tk.END)
                self.restore_text.insert(tk.END, f"Loaded backup file: {file_path}\n")
                self.restore_text.insert(tk.END, "You can now preview or restore the data.")
            except Exception as e:
                messagebox.showerror("Error", f"Error loading backup file: {e}")

    def preview_restore(self):
        if not self.backup_data:
            messagebox.showerror("Error", "No backup file loaded.")
            return
        self.restore_text.delete(1.0, tk.END)
        try:
            samples = self.backup_data[:5]
            if samples:
                self.restore_text.insert(tk.END, "Sample data to restore:\n\n")
                for doc in samples:
                    self.restore_text.insert(tk.END, json.dumps(doc, default=str, indent=4) + "\n\n")
            else:
                self.restore_text.insert(tk.END, "No documents to restore.")
        except Exception as e:
            self.restore_text.insert(tk.END, f"Error: {e}")

    def restore_collection(self):
        if not self.backup_data:
            messagebox.showerror("Error", "No backup file loaded.")
            return
        collection_name = self.restore_collection_var.get()
        collection = collections[collection_name]
        confirm = messagebox.askyesno("Confirm", f"Are you sure you want to restore the '{collection_name}' collection?\nThis will overwrite existing data.")
        if confirm:
            threading.Thread(target=self._restore_collection_thread, args=(collection,)).start()

    def _restore_collection_thread(self, collection):
        try:
            collection.delete_many({})
            if self.backup_data:
                collection.insert_many(self.backup_data)
                messagebox.showinfo("Success", f"Restored {len(self.backup_data)} documents to '{collection.name}'.")
                self.view_collection_stats()
            else:
                messagebox.showinfo("Info", "No data to restore.")
        except Exception as e:
            messagebox.showerror("Error", f"Error restoring collection: {e}")

    def create_places_tab(self):
        ttk.Label(self.places_frame, text="Manage Places Collection", font=('Helvetica', 14)).pack(pady=10)
        
        # Add buttons for common places operations
        ttk.Button(self.places_frame, text="View Places", command=self.view_places).pack(pady=5)
        ttk.Button(self.places_frame, text="Validate Place Geometries", command=self.validate_place_geometries).pack(pady=5)
        ttk.Button(self.places_frame, text="Recalculate Visit Statistics", command=self.recalculate_visit_stats).pack(pady=5)
        
        self.places_text = ScrolledText(self.places_frame, height=20, width=90)
        self.places_text.pack(pady=10)

    def view_places(self):
        self.places_text.delete(1.0, tk.END)
        try:
            places = list(places_collection.find().limit(5))
            if places:
                for place in places:
                    self.places_text.insert(tk.END, json.dumps(place, default=str, indent=4) + "\n\n")
            else:
                self.places_text.insert(tk.END, "No places found in the collection.")
        except Exception as e:
            self.places_text.insert(tk.END, f"Error viewing places: {e}")

    def validate_place_geometries(self):
        try:
            places = places_collection.find()
            invalid_places = []
            for place in places:
                try:
                    shape(place['geometry'])
                except Exception:
                    invalid_places.append(place['_id'])
            
            if invalid_places:
                self.places_text.delete(1.0, tk.END)
                self.places_text.insert(tk.END, f"Found {len(invalid_places)} invalid place geometries:\n")
                for place_id in invalid_places:
                    self.places_text.insert(tk.END, f"Place ID: {place_id}\n")
            else:
                messagebox.showinfo("Success", "All place geometries are valid.")
        except Exception as e:
            messagebox.showerror("Error", f"Error validating place geometries: {e}")

    def recalculate_visit_stats(self):
        try:
            places = places_collection.find()
            for place in places:
                geometry = shape(place['geometry'])
                visits = 0
                last_visit = None
                
                # Check trips that might intersect with this place
                for trip in trips_collection.find():
                    if 'gps' in trip:
                        trip_coords = json.loads(trip['gps'])['coordinates']
                        trip_line = LineString(trip_coords)
                        if geometry.intersects(trip_line):
                            visits += 1
                            trip_time = trip['endTime']
                            if not last_visit or trip_time > last_visit:
                                last_visit = trip_time
                
                # Update place statistics
                places_collection.update_one(
                    {'_id': place['_id']},
                    {'$set': {
                        'visitCount': visits,
                        'lastVisit': last_visit
                    }}
                )
            
            messagebox.showinfo("Success", "Visit statistics have been recalculated for all places.")
        except Exception as e:
            messagebox.showerror("Error", f"Error recalculating visit statistics: {e}")

if __name__ == "__main__":
    app = DatabaseUtilitiesGUI()
    app.mainloop()