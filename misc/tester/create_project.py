import requests
import json
import random

def create_project():
    url = 'http://localhost:8200/api/projects'
    project = {
        'label': f'Test project {random.random()*100}',
        'description': 'Here is the description of this project.'
    }

    response = requests.post(url, json=project)

    if response.status_code == 200:
        result = response.json()
        project_id = result['result'][0]['@rid']
        return project_id
    else:
        print("Error:", response.text)
        return None

# Example usage
project_id = create_project()
if project_id:
    print("Project created successfully with ID:", project_id)
else:
    print("Failed to create project.")
