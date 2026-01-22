import sys
import os

# Add the project root to the python path
sys.path.append(os.getcwd())

try:
    from map_data.models import MapServiceConfig

    print("MapServiceConfig imported successfully.")
    # Try to rebuild the model to trigger the error if it wasn't triggered by import
    try:
        MapServiceConfig.model_rebuild()
        print("MapServiceConfig.model_rebuild() successful.")
    except Exception as e:
        print(f"MapServiceConfig.model_rebuild() failed: {e}")

except Exception as e:
    print(f"Failed to import MapServiceConfig: {e}")
