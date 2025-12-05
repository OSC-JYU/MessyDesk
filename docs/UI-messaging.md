


When setProcess is created, it has status "running".
- service must call /api/nomad/services/done in order to change state to "done"

## SINGLE FILE PROCESSING:

When Process is added to single file:

    {
        command: "add",
        input: [RID],    // RID of file node
        node: {status: "running", [... rest of node data]}
    }

When process outputs file to single file:

    {
        command: "add",
        input: [RID],  	// RID of process node
        node: {}
    }

When updating single file (like adding thumnbnail):

    {
        command: "update",
        target: [RID],  	// RID of File node
        node: {[UPDATED PARAMS]}
    }

When processing is done:

    {
        command: "process_finished",
        target: [RID],  	// RID of process node
        node: {status: "done"}
    }	


## SET PROCESSING:

WHen Process is added to Set:

    {
        command: "add",
        input: [RID],    // RID of set node
        node: {status: "running", [... rest of Process node data]}
        output: {status_"running", [... rest of Set node data]}
    }

When process outputs file to set:

    {
        command: "process_update",
        target: [RID],    // RID of set node
        total_count: [TOTAL COUNT OF SET FILES],
        current_count: [NUMBER OF FILES PROCESSED]

    }

When processing ins finished:

    {
        command: "process_finished",
        target: [RID],  	// RID of process node
        node: {status: "done"}
    }