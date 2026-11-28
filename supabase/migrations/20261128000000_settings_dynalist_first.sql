-- Whether the Dynalist card shows above the task list (the switch at the top of todo.html).
alter table settings add column dynalist_first boolean not null default false;
