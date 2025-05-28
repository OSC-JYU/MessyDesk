# This script create a demo Desk for user, adds file to it and do some prosessing of the file
# This also demonstrates how MessyDesk API can be used externally.

# USAGE
# python init_user.py local.user@localhost


import requests
import argparse
import json
import sys

image1 = ''
image2 = ''

# Parse command-line arguments
parser = argparse.ArgumentParser(description="Send a POST request to create a project.")
parser.add_argument("mail", help="Email for authentication")
args = parser.parse_args()


# 1. Create Desk

# Define the API endpoint
url = "http://localhost:8200/api/projects"

# Define the request payload
data = {
    "label": "Ensimmäinen rouskuttelu",
    "description": "Lue minut!"
}

# Define the headers (optional, depending on API requirements)
headers_auth = {
    "mail": args.mail
}


headers = {
    "Content-Type": "application/json",
    "mail": args.mail
}


# Make the POST request
response = requests.post(url, json=data, headers=headers)

# Print response
print("Status Code:", response.status_code)
print("Response Body:", response.text)

data_json = json.loads(response.text)

if 'error' in data_json:
    print(data_json['error'])
    print('exiting...')
    sys.exit()
else:
    print(data_json['@rid'])




# 2. Add files to Desk

# TEXT IMAGE
files = {"file": ("demo_text_fin.jpg", open("test/files/text_fin.jpg", "rb"), "image/jpeg")}

url = f"http://localhost:8200/api/projects/{data_json['@rid'].replace('#','')}/upload"

upload_response = requests.post(url, files=files, headers=headers_auth)
upload_json = json.loads(upload_response.text)

if 'error' in upload_json:
    print(upload_json['error'])
    print('exiting...')
    sys.exit()
else:
    print(upload_json['@rid'])
    image2 = upload_json['@rid'].replace('#','')


# CAT IMAGE
files = {"file": ("kissa.jpg", open("test/files/kissa.jpg", "rb"), "image/jpeg")}

url = f"http://localhost:8200/api/projects/{data_json['@rid'].replace('#','')}/upload"

upload_response = requests.post(url, files=files, headers=headers_auth)
upload_json = json.loads(upload_response.text)

if 'error' in upload_json:
    print(upload_json['error'])
    print('exiting...')
    sys.exit()
else:
    print(upload_json['@rid'])
    image1 = upload_json['@rid'].replace('#','')

## add description to image

url = f"http://localhost:8200/api/graph/vertices/{image1.replace('#','')}"
upload_response = requests.post(url, json={"key": "description", "value": "Kissalla on aina hyvä aloittaa."}, headers=headers)



# 3. Run pipeline for image

# with open('test/pipeline/demo1_ocr_fin.json', 'r') as file:
#     pipeline_json = json.load(file)

# url = f"http://localhost:8200/api/pipeline/files/{image2}"

# pipeline_response = requests.post(url, json=pipeline_json, headers=headers)

# print(pipeline_response.text)



with open('test/pipeline/demo1_fin.json', 'r') as file:
    pipeline_json = json.load(file)

url = f"http://localhost:8200/api/pipeline/files/{image1}"

pipeline_response = requests.post(url, json=pipeline_json, headers=headers)

print(pipeline_response.text)








