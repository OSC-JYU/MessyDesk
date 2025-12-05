# Files, Services, Tasks, Queues and Messages

MessyDesk is built on five core components that work together to process files. This introduction explains how each part functions and how they connect.

## How It All Works Together

Imagine you want to extract text from a image using OCR. You upload your image file to MessyDesk and choose OCR service. The system creates a message that says "take this image file and run OCR on it." This message goes into a queue, waiting for the OCR service to be ready. When ready, the service processes your file and returns the results. The outputs are saved as new files, which you can then process further if needed.

## Files

Everything in MessyDesk revolves around files. You start with files—PDFs, images, documents—and when you process them, the results are also files. A processed PDF might become multiple text files, or an image might generate thumbnails and metadata files. Files flow through the system, being transformed step by step into the information you need.

Files are organized in your project folders, and each processing step creates new files that you can view, download, or process further. This file-centric approach makes it easy to see what happened at each stage.

## Services

Services are the tools that do the actual work. Think of them as specialized helpers: one might extract text from images (OCR), another might analyze language patterns, and another might resize or format pictures. Each service knows how to handle specific types of files and can perform particular tasks.

Services are independent applications that can run anywhere—on your local computer, on a server cluster, or even in the cloud. This flexibility means MessyDesk can use powerful tools without needing to install everything directly. When you want to process a file, MessyDesk finds the right service and sends your file to it.

## Tasks

Tasks are what users see as "Crunchers" in the interface. Each task is a specific job a service can do—like "extract text" or "create thumbnail" or "detect language." When you click a Cruncher, you're telling MessyDesk: "run this task on this file."

Tasks are defined in service configuration files, which tell MessyDesk what each service can do, what types of files it accepts, and what parameters you can adjust. This setup makes it easy to add new capabilities—you just add a new service with its tasks, and they automatically appear in MessyDesk.

## Messages

Messages are like work orders that travel with your file through the system. When you start processing a file, MessyDesk creates a message that contains everything needed: which file to process, which task to run, any settings you chose, and where to save the results.

The message follows your file from start to finish. It goes to the service with instructions, the service processes according to those instructions, and then the message comes back with the results. Messages are stored on the file system, so you can always see what was requested and what happened.

## Queues

Processing files can take time and use significant resources. To prevent overwhelming the system, MessyDesk uses queues to organize work. Think of it like a waiting line at a busy store—when you request processing, your task joins a queue. The system processes tasks one at a time (or a few at a time), ensuring everything runs smoothly without crashing under too much simultaneous work.

Queues ensure that each service gets work in an orderly fashion. Instead of everyone's requests hitting a service at once and causing problems, they wait their turn. This makes the system reliable even when many people are using it at the same time.

