# Services

Services do the actual work. They are separate applications running outside MessyDesk.



## How MessyDesk knows what services are available?

Services are defined in services directory with json files. These files tell the name of the service and what crunchers (tasks) there are. They also define what adapter must be used (adapters are MD-consumers) and there is also information what files are supported for each crunchers.


## How crunhers are linked to certain types of files?

service.json files has two settings for that.

Here is an example of imaginary service:

    "supported_types": ["image"],
    "supported_formats": ["png", "jpg","jpeg","webp","tiff","tif"],

This means that in general tasks in imaginary service can be used with files with these extension.

Let's say you have a NER Cruncher that outputs specific type of json with certain structure. Let's call that type as "ner.json" Now you want to create a Cruncher that can process that json file. You can do this by setting the type of the json to "ner.json" and extension to "json". Then you can create a service with task that has following line:

    "supported_types": ["ner.json"],

Now this task appears when you click this type of file in MessyDesk. It is also processable with Crunchers that has "supported_formats: json".

The order where the match between crunchers and files is following:

1. Task specific supported_types
2. Task specific supported_format
3. Service specific supported_types
4. Service specific supported_formats