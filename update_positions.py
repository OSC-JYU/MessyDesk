import json
import os
import re
import requests
from requests.auth import HTTPBasicAuth

def update_positions(layouts_dir='data/layouts'):
    """
    Read JSON files from layouts directory and generate SQL update statements.
    
    Args:
        layouts_dir (str): Directory containing layout JSON files
        
    Returns:
        list: List of SQL update statements
    """
    sql_statements = []
    
    # Check if directory exists
    if not os.path.exists(layouts_dir):
        print(f"Directory {layouts_dir} does not exist")
        return sql_statements
    
    # Process each JSON file in the directory
    for filename in os.listdir(layouts_dir):
        if not filename.endswith('.json'):
            continue
            
        file_path = os.path.join(layouts_dir, filename)
        
        try:
            with open(file_path, 'r') as f:
                layout_data = json.load(f)
                
            # Process each key-value pair in the JSON
            for rid, position in layout_data.items():
                # Extract x and y values
                x = position.get('x')
                y = position.get('y')
                
                if x is not None and y is not None:
                    # Generate SQL statement
                    sql = f"UPDATE Project SET position = {{x:{x}, y:{y}}} WHERE @rid = '{rid}'"
                    sql_statements.append(sql)
                    
        except json.JSONDecodeError as e:
            print(f"Error parsing {filename}: {e}")
        except Exception as e:
            print(f"Error processing {filename}: {e}")
    
    return sql_statements

def execute_sql_statements(sql_statements, db_name='messydesk', username='root', password='node_master'):
    """
    Execute SQL statements against ArcadeDB.
    
    Args:
        sql_statements (list): List of SQL statements
        db_name (str): Database name
        username (str): Database username
        password (str): Database password
    """
    base_url = 'http://localhost:2480'
    auth = HTTPBasicAuth(username, password)
    
    for sql in sql_statements:
        try:
            # Prepare the request
            url = f"{base_url}/api/v1/command/{db_name}"
            headers = {'Content-Type': 'application/json'}
            data = {'command': sql, 'language': 'sql'}
            
            # Send the request
            response = requests.post(url, json=data, auth=auth)
            
            # Check response
            if response.status_code == 200:
                print(f"Successfully executed: {sql}")
            else:
                print(f"Error executing {sql}: {response.status_code} - {response.text}")
                
        except requests.exceptions.RequestException as e:
            print(f"Request failed for {sql}: {e}")

if __name__ == '__main__':
    # Generate SQL statements
    sql_statements = update_positions()
    
    # Execute SQL statements
    if sql_statements:
        print(f"Executing {len(sql_statements)} SQL statements...")
        execute_sql_statements(sql_statements)
    else:
        print("No SQL statements to execute") 