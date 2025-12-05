import networkx as nx
import sys

print(f"NetworkX version: {nx.__version__}")

try:
    G = nx.MultiGraph()
    G.add_edge(1, 2, length=10)
    print("Graph created")
    
    u, v = 1, 2
    print(f"Accessing G.edges[{u}, {v}]")
    try:
        # This is the line causing issues in route_solver.py
        data = G.edges[u, v]
        print(f"Data: {data}")
    except Exception as e:
        print(f"Error accessing G.edges[{u}, {v}]: {e}")
        import traceback
        traceback.print_exc()

except Exception as e:
    print(f"Top level error: {e}")
