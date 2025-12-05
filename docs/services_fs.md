# File storage services

File storage services reads and saves files directly to MessyDesk data path. This is of cource much more faster than sending them via REST API. In order this to work, service must has access to the MD data directory.


## The role of adapter?

Since file access happens directly from drive, the adapter does not send files. However, the adapter do sends message JSON from the queu to the rest API of the service. 