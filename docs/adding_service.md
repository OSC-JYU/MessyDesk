# Adding new services

[DRAFT!]

Services can be written in any language and they can be located in the cloud or running locally.
Only requirement is that there must be service adapter (MD-consumer) that knows how to call that service.

If you write service yourself, you can use elg adapter. If you want to add service that already have rest api, then you must write service adapter for it.

## Service behaviour modes

There are three ways service can behave.

1. one-to-one
- When service is run for set, we create output set
output_set: "name of the set to be created"
- We create message for every file
- we receive one file that is labeled based on original file
- example: rotate image

2. one-to-many
- We always create a set, both for sets and individual files
output_set: "name of the set to be created"
- we create message for every file
- we receive array of files, labeling is up to service
- example: extract images from PDF

3. many-to-one
- When service is run for set, we create output set
output_set: "name of the set to be created"
- We create message for every file
- We receive one file per source file (if found)
- example: join texts
This is the smart version of many-to-one. This is important for example PDF processing. When we have splitted several PDF files to pages, and we want to combine texts that are extracted from those pages, we do not want one huge text file but we want one text file per original PDF.

Logic: If we run many-to-one to a set and we find set of pdf or text files (not page files) from lineage (root level), then we group outputs per that PDF file.
If previous processing is many-to-one-by-source, then we combine all files to one. This allows user to have that one huge text by adding this service twice.

4. many-to-one-raw
- We never create set
- We create message for every file
- We receive one file when the process finishes
- example: zip (streams output)

By default (if not defined in service.json) behaviour is one-to-one.

## Service types

1. Services that outputs one image or text file (one-to-one)
These are the most simplest services. For example a service that converts image to greyscale image.


Basically you need an app that implements very simple API that consumer calls. Consumers has different kind of adapter that knows how to call different kind of APIs. Good default is ELG.

service.json


/process


2. Services that ouputs one or more image or text files (one-to-many)

If service **can** output more than one output file, then a set must be created for outputs when processing individual files (instead of sets of files).
This can be defined in service.json by following way:

            "output": "set",
            "output_set": "Pages from PDF",



3. Services that outputs one file from many input files (many-to-one)

A good example of this kind of service is zip service. It reads all files from set and outputs one file. This behaviour is defined in service.json like this:



4. Services that outputs something else than image or text files.

Service can return for example a JSON file as a result. But JSON files can hold data in different formats. That's why JSON files in MessyDesk has type. Type tells what that data is and how it must be treated and displayed. JSON type also allows writing services that are available only for this type of JSON files.

Some questions to be answered:
- If it is JSON, then what the type of JSON.
- How is output shown to user?
If output is JSON, then the default display show user the raw JSON file. If something more subtle is needed, one have to write a display component for it.

- What user can do with that file?
Are there any service that can consume that data as input?

5. Prompt based services

If you want to use large language models or vision models, then you have to deal with prompts. These AI services does not have tasks in service.json but task are prompts in prompt gallery of MessyDesk. This allows you to run same prompts with different models.


## Service cancel, pause and resume

Services do not need to handle service cancel or resume. Cancelling running service is based on removing all messages from queue for that particular process node. Resume, in other hand is based on state of the graph. Resume re-creates messages for files that do not have link to output file produced by current process.




