# Error handling

It is very likely that at some point processing of file fails. It can be corrupted file, network problem or just glitch in processing code. In that case MessyDesk tries to create error file, that is shown in UI.

This file is called error.json and it includes the original Nats -message and the error that was returned.