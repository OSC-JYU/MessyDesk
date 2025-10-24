#!/usr/bin/env python3
"""
Script to read service.json files from MessyDesk/services directory
and extract local_url, id, and name for each service.
"""

import json
import os
from pathlib import Path


def extract_port_number(url):
    """
    Extract port number from URL for sorting purposes.
    Returns 0 for empty URLs, port number for localhost URLs, 99999 for other URLs.
    """
    if not url or url == "":
        return 0
    
    if url.startswith("http://localhost:"):
        try:
            port = int(url.split(":")[-1])
            return port
        except (ValueError, IndexError):
            return 99999
    
    return 99999


def read_services(services_dir="/home/arihayri/Projects/MessyDesk/services"):
    """
    Read all service.json files from the services directory and extract
    local_url, id, and name for each service.
    
    Args:
        services_dir (str): Path to the services directory
        
    Returns:
        list: List of dictionaries containing service information, sorted by port number
    """
    services = []
    services_path = Path(services_dir)
    
    if not services_path.exists():
        print(f"Error: Services directory '{services_dir}' does not exist.")
        return services
    
    # Iterate through all subdirectories in the services directory
    for service_dir in services_path.iterdir():
        if service_dir.is_dir():
            service_json_path = service_dir / "service.json"
            
            if service_json_path.exists():
                try:
                    with open(service_json_path, 'r', encoding='utf-8') as f:
                        service_data = json.load(f)
                    
                    # Extract the required fields
                    service_info = {
                        'local_url': service_data.get('local_url', ''),
                        'id': service_data.get('id', ''),
                        'name': service_data.get('name', '')
                    }
                    
                    services.append(service_info)
                    
                except json.JSONDecodeError as e:
                    print(f"Error parsing JSON in {service_json_path}: {e}")
                except Exception as e:
                    print(f"Error reading {service_json_path}: {e}")
            else:
                print(f"Warning: No service.json found in {service_dir}")
    
    # Sort services by port number (lowest to highest)
    services.sort(key=lambda x: extract_port_number(x['local_url']))
    
    return services


def print_services(services):
    """
    Print the services in a formatted ASCII table with URL first, then ID, then Name.
    
    Args:
        services (list): List of service dictionaries
    """
    if not services:
        print("No services found.")
        return
    
    # Calculate column widths
    max_url_len = max(len(service['local_url']) for service in services)
    max_id_len = max(len(service['id']) for service in services)
    max_name_len = max(len(service['name']) for service in services)
    
    # Ensure minimum widths
    max_url_len = max(max_url_len, 9)  # "Local URL"
    max_id_len = max(max_id_len, 3)  # "ID"
    max_name_len = max(max_name_len, 4)  # "Name"
    
    # Create table borders
    total_width = max_url_len + max_id_len + max_name_len + 8  # +8 for separators and padding
    
    # Print top border
    print("┌" + "─" * (max_url_len + 2) + "┬" + "─" * (max_id_len + 2) + "┬" + "─" * (max_name_len + 2) + "┐")
    
    # Print header
    print(f"│ {'Local URL':<{max_url_len}} │ {'ID':<{max_id_len}} │ {'Name':<{max_name_len}} │")
    
    # Print separator
    print("├" + "─" * (max_url_len + 2) + "┼" + "─" * (max_id_len + 2) + "┼" + "─" * (max_name_len + 2) + "┤")
    
    # Print services
    for service in services:
        url = service['local_url'] if service['local_url'] else "(external)"
        print(f"│ {url:<{max_url_len}} │ {service['id']:<{max_id_len}} │ {service['name']:<{max_name_len}} │")
    
    # Print bottom border
    print("└" + "─" * (max_url_len + 2) + "┴" + "─" * (max_id_len + 2) + "┴" + "─" * (max_name_len + 2) + "┘")


def main():
    """Main function to run the script."""
    print("Reading services from MessyDesk/services directory...")
    print()
    
    services = read_services()
    
    if services:
        print(f"Found {len(services)} services:")
        print()
        print_services(services)
        
        # Also print as JSON for programmatic use
        # print("\n" + "="*50)
        # print("JSON output:")
        # print(json.dumps(services, indent=2))
    else:
        print("No services found.")


if __name__ == "__main__":
    main()
